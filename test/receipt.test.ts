// Phase 6: receipt photos. Zod validation, the sum check, tax allocation, card-number scrubbing,
// who paid and whose items are whose, and the full flow through the router with a stand-in reader.

import { afterEach, describe, expect, test } from "bun:test";
import type { GeminiLike } from "../src/agent/loop";
import { resetClock, setNow } from "../src/clock";
import { balancesFor } from "../src/domain/expenses";
import { importFoodKeeperFile } from "../src/domain/foodkeeper";
import { getMembers } from "../src/domain/household";
import { computeSplit } from "../src/domain/splits";
import { Inbox } from "../src/inbox";
import { Outbox } from "../src/outbox";
import { makeRouter } from "../src/router";
import { getPendingReceipt, parseReceiptReply } from "../src/receipts/flow";
import {
  allocate,
  checkReceipt,
  cleanName,
  downloadImage,
  parseReceiptJson,
  readReceipt,
  ReceiptError,
  type RawReceipt,
} from "../src/receipts/receipt";
import { FakeAdapter, PHONES, quietLog, setupHousehold } from "./helpers";

const T0 = new Date("2026-11-14T15:00:00Z");
afterEach(() => resetClock());

const TJ: RawReceipt = {
  store: "Trader Joe's",
  items: [
    { name: "baby spinach", price: "3.99" },
    { name: "chicken thighs", price: "8.99" },
    { name: "bananas", price: "1.79" },
    { name: "eggs", price: "4.49" },
  ],
  tax: "0.84",
  total: "20.10",
};

describe("reading and validating", () => {
  test("Zod: code fences are tolerated; a missing total or no items is rejected", () => {
    expect(parseReceiptJson("```json\n" + JSON.stringify(TJ) + "\n```").total).toBe("20.10");
    expect(() => parseReceiptJson(JSON.stringify({ items: TJ.items }))).toThrow(ReceiptError);
    expect(() => parseReceiptJson(JSON.stringify({ items: [], total: "3" }))).toThrow(ReceiptError);
    expect(() => parseReceiptJson("not json")).toThrow(ReceiptError);
  });

  test("readReceipt sends the image inline with store:false and a JSON schema", async () => {
    let params: Record<string, any> = {};
    const client: GeminiLike = {
      interactions: {
        create: async (p) => {
          params = p;
          return { status: "completed", output_text: JSON.stringify(TJ), steps: [] };
        },
      },
    };
    const r = await readReceipt(client, "m", { bytes: new Uint8Array([1, 2, 3]), mime: "image/heic" });
    expect(r.items).toHaveLength(4);
    expect(params.store).toBe(false);
    expect(params.response_format.mime_type).toBe("application/json");
    const image = params.input[0].content[1];
    expect(image).toEqual({ type: "image", data: "AQID", mime_type: "image/heic" });
  });

  test("readReceipt times out cleanly", async () => {
    const slow: GeminiLike = { interactions: { create: () => new Promise(() => {}) } };
    await expect(readReceipt(slow, "m", { bytes: new Uint8Array([1]), mime: "image/jpeg" }, 20)).rejects.toMatchObject({ code: "timeout" });
  });

  test("download: retries with the Bearer key on 403, rejects non-images and file:// outside the terminal", async () => {
    const seen: (string | undefined)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      seen.push(auth);
      return auth ? new Response(new Uint8Array([9, 9]), { headers: { "content-type": "image/jpeg" } }) : new Response("no", { status: 403 });
    }) as unknown as typeof fetch;
    const img = await downloadImage({ url: "https://x/a" }, { apiKey: "k", fetchImpl });
    expect(img).toMatchObject({ mime: "image/jpeg" });
    expect(seen).toEqual([undefined, "Bearer k"]);

    const pdf = (async () => new Response("x", { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch;
    await expect(downloadImage({ url: "https://x/doc" }, { fetchImpl: pdf })).rejects.toMatchObject({ code: "not_image" });
    await expect(downloadImage({ url: "file:///tmp/r.jpg" })).rejects.toMatchObject({ code: "download" });
  });
});

describe("checking the math", () => {
  test("items + tax - discounts = total within 1 cent; a 5 cent gap is flagged", () => {
    expect(checkReceipt(TJ)).toMatchObject({ itemsCents: 1926, taxCents: 84, totalCents: 2010, balanced: true });
    expect(checkReceipt({ ...TJ, total: "20.11" }).balanced).toBe(true);
    expect(checkReceipt({ ...TJ, total: "20.15" })).toMatchObject({ balanced: false, diffCents: -5 });
  });

  test("coupon lines count as discounts, unless a savings total is printed", () => {
    const withCoupon = { ...TJ, items: [...TJ.items, { name: "coupon", price: "-1.00" }], total: "19.10" };
    expect(checkReceipt(withCoupon)).toMatchObject({ discountCents: 100, balanced: true, items: expect.any(Array) });
    expect(checkReceipt(withCoupon).items).toHaveLength(4);
    expect(checkReceipt({ ...withCoupon, discounts: "1.00" })).toMatchObject({ discountCents: 100, balanced: true });
  });

  test("card numbers and payment lines never survive", () => {
    const r = checkReceipt({
      ...TJ,
      items: [...TJ.items, { name: "VISA XXXX1234", price: "20.10" }, { name: "4011 BANANAS ORG", price: "0.00" }, { name: "SUBTOTAL", price: "19.26" }],
    });
    expect(r.items.map((i) => i.name)).not.toContain("VISA XXXX1234");
    for (const i of r.items) expect(i.name).not.toMatch(/\d{4,}/);
    expect(r.items.map((i) => i.name)).toEqual(["baby spinach", "chicken thighs", "bananas", "eggs"]); // $0.00 line dropped too
    expect(cleanName("**** **** 4242 card")).not.toMatch(/\d/);
    expect(r.dropped).toBe(3);
  });

  test("allocation: kept items carry their share of tax, and shares always sum to the total", () => {
    const r = checkReceipt(TJ);
    r.items[1]!.owners = [1]; // chicken is Alex's
    const alloc = allocate(r.items, r.totalCents);
    expect(alloc).toEqual([{ amountCents: 899 + Math.floor((84 * 899) / 1926), memberIds: [1] }]);

    // Property: random receipts, random owners, the split always sums exactly.
    for (let n = 0; n < 1000; n++) {
      const items = Array.from({ length: 1 + (n % 7) }, (_, i) => ({ name: `i${i}`, cents: 1 + ((n * 37 + i * 101) % 2000), owners: (n + i) % 3 === 0 ? [1 + ((n + i) % 3)] : (n + i) % 5 === 0 ? [2, 3] : null }));
      const subtotal = items.reduce((s, i) => s + i.cents, 0);
      const total = Math.max(1, subtotal + ((n % 11) - 5) * 13);
      const { shares } = computeSplit({ totalCents: total, buyerId: 1, memberIds: [1, 2, 3], allocations: allocate(items, total) });
      expect([...shares.values()].reduce((s, v) => s + v, 0)).toBe(total);
    }
  });
});

describe("replies: who paid, whose items", () => {
  const db = setupHousehold();
  const members = getMembers(db, 1);
  test("parses yes, buyer, ownership, total, and cancel", () => {
    expect(parseReceiptReply("yes", members, 1)).toMatchObject({ confirm: true, assign: [] });
    expect(parseReceiptReply("Sam paid", members, 1)).toMatchObject({ confirm: false, buyerId: 2 });
    expect(parseReceiptReply("paid by jordan", members, 1)).toMatchObject({ buyerId: 3 });
    expect(parseReceiptReply("I paid", members, 2)).toMatchObject({ buyerId: 2 });
    expect(parseReceiptReply("yes, 2 is mine and 3 and 4 are Sam's", members, 1)).toMatchObject({
      confirm: true,
      assign: [{ index: 2, owners: [1] }, { index: 3, owners: [2] }, { index: 4, owners: [2] }],
    });
    expect(parseReceiptReply("2 is shared", members, 1)).toMatchObject({ assign: [{ index: 2, owners: null }] });
    expect(parseReceiptReply("5 is me and Sam's", members, 1)).toMatchObject({ assign: [{ index: 5, owners: [1, 2] }] });
    expect(parseReceiptReply("2 is mine and Sam paid", members, 1)).toMatchObject({ buyerId: 2, assign: [{ index: 2, owners: [1] }] });
  });

  test("parses who shares the rest of the receipt", () => {
    expect(parseReceiptReply("split with Sam only", members, 1)).toMatchObject({ splitAmong: [1, 2] });
    expect(parseReceiptReply("split between Sam and Jordan", members, 1)).toMatchObject({ splitAmong: [2, 3] });
    expect(parseReceiptReply("yes, just me and Jordan", members, 1)).toMatchObject({ confirm: true, splitAmong: [1, 3] });
    expect(parseReceiptReply("split it evenly", members, 1)).toMatchObject({ splitAmong: null });
    expect(parseReceiptReply("split with Sam, 2 is mine", members, 1)).toMatchObject({ splitAmong: [1, 2], assign: [{ index: 2, owners: [1] }] });
    expect(parseReceiptReply("split with Riley", members, 1)?.error).toContain("Riley");
    expect(parseReceiptReply("total is $20.15", members, 1)).toMatchObject({ totalCents: 2015 });
    expect(parseReceiptReply("cancel", members, 1)).toMatchObject({ cancel: true });
    expect(parseReceiptReply("Riley paid", members, 1)?.error).toContain("Riley");
    expect(parseReceiptReply("what's for dinner", members, 1)).toBeNull();
  });
});

async function app(read: () => Promise<RawReceipt>, opts: { client?: boolean } = {}) {
  const db = setupHousehold();
  await importFoodKeeperFile(db);
  db.run("INSERT INTO state (key, value) VALUES ('intro:chat-1', 't')");
  const adapter = new FakeAdapter();
  const outbox = new Outbox(db, adapter, { sleep: async () => {}, log: quietLog });
  const router = makeRouter({
    db, outbox, adapter, botName: "Thyme", model: "x", client: null, log: quietLog,
    receipts: opts.client === false ? undefined : { read },
  });
  const inbox = new Inbox(db, router, { debounceMs: 5 });
  await adapter.start({ onMessage: (m) => inbox.push(m) });
  const say = async (from: string, text: string, photo = false) => {
    const before = adapter.sent.length;
    adapter.receive({ from, text, attachments: photo ? [{ url: "https://claw/att/1", mimeType: "image/jpeg" }] : [] });
    await new Promise((r) => setTimeout(r, 25));
    await inbox.drain();
    return adapter.sent.slice(before).map((s) => s.text).join("\n---\n");
  };
  return { db, adapter, say };
}

describe("receipt flow through the router", () => {
  test("photo -> list -> 'Sam paid' -> 'yes, 2 is Jordan's' -> expense + fridge items; undo", async () => {
    setNow(T0);
    const { db, say } = await app(async () => TJ);
    const shown = await say(PHONES[0]!, "", true);
    expect(shown).toContain("Got the Trader Joe's receipt:");
    expect(shown).toContain("2. chicken thighs $8.99");
    expect(shown).toContain("tax $0.84, total $20.10.");
    expect(shown).toContain("Paid by Alex.");
    expect(db.query("SELECT COUNT(*) AS n FROM expenses").get()).toEqual({ n: 0 }); // nothing saved yet

    // Nothing about the image is stored.
    const pending = db.query<{ value: string }, []>("SELECT value FROM state WHERE key LIKE 'receipt:%'").get()!.value;
    expect(pending).not.toContain("https://");
    expect(pending).not.toContain("base64");

    expect(await say(PHONES[0]!, "Sam paid")).toContain("Paid by Sam.");
    const saved = await say(PHONES[0]!, "yes, 2 is Jordan's");
    const jordanShare = 899 + Math.floor((84 * 899) / 1926);
    expect(saved).toContain("Saved: $20.10 paid by Sam.");
    expect(saved).toContain("Added 4 items to the fridge list");

    const e = db.query<{ buyer_member_id: number; source: string; total_cents: number }, []>("SELECT buyer_member_id, source, total_cents FROM expenses").get()!;
    expect(e).toEqual({ buyer_member_id: 2, source: "receipt", total_cents: 2010 });
    const shares = db.query<{ member_id: number; share_cents: number }, []>("SELECT member_id, share_cents FROM expense_shares ORDER BY member_id").all();
    expect(shares.reduce((s, x) => s + x.share_cents, 0)).toBe(2010);
    const rest = 2010 - jordanShare;
    expect(shares.find((s) => s.member_id === 3)!.share_cents).toBe(jordanShare + Math.floor(rest / 3));
    expect(balancesFor(db, 1, 2).netCents).toBe(2010 - shares.find((s) => s.member_id === 2)!.share_cents);

    const items = db.query<{ name: string; cost_cents: number; cost_source: string; owner_member_id: number | null; buyer_member_id: number }, []>(
      "SELECT name, cost_cents, cost_source, owner_member_id, buyer_member_id FROM items WHERE cost_source = 'receipt' ORDER BY id",
    ).all();
    expect(items.map((i) => i.name)).toEqual(["baby spinach", "chicken thighs", "bananas", "eggs"]);
    expect(items.find((i) => i.name === "chicken thighs")).toMatchObject({ cost_cents: 899, owner_member_id: 3, buyer_member_id: 2 });
    expect(getPendingReceipt(db, 1)).toBeNull();

    // The person who sent the receipt can undo it, even though Sam paid.
    expect(await say(PHONES[0]!, "undo")).toContain("$20.10 expense is removed");
  });

  test("non-food lines count toward the bill but stay out of the fridge; store numbers are dropped", async () => {
    setNow(T0);
    const { db, say } = await app(async () => ({ ...TJ, store: "TRADER JOE'S #551", items: [...TJ.items, { name: "bag fee", price: "0.10" }], total: "20.20" }));
    expect(await say(PHONES[0]!, "", true)).toContain("Got the TRADER JOE'S receipt:");
    const saved = await say(PHONES[0]!, "yes");
    expect(saved).toContain("Saved: $20.20");
    expect(saved).toContain("Not added to the fridge (not food): bag fee.");
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE name LIKE '%bag%'").get()).toEqual({ n: 0 });
  });

  test("split with only some roommates; an item shared by two stays shared in the fridge", async () => {
    setNow(T0);
    const { db, say } = await app(async () => TJ);
    await say(PHONES[0]!, "", true);
    expect(await say(PHONES[0]!, "4 is me and Sam's, split between Alex and Jordan")).toContain("The rest is split between Alex and Jordan.");
    const saved = await say(PHONES[0]!, "yes");
    expect(saved).toContain("Saved: $20.10 paid by Alex.");
    const share = (id: number) => db.query<{ s: number }, [number]>("SELECT share_cents AS s FROM expense_shares WHERE member_id = ?").get(id)?.s ?? 0;
    const eggs = 449 + Math.floor((84 * 449) / 1926); // item 4, split by Alex and Sam
    const rest = 2010 - eggs;
    expect(share(2)).toBe(Math.floor(eggs / 2)); // Sam: half the eggs, none of the rest
    expect(share(3)).toBe(Math.floor(rest / 2)); // Jordan: half the rest, no eggs
    expect(share(1) + share(2) + share(3)).toBe(2010);
    const eggsRow = db.query<{ owner_member_id: number | null }, []>("SELECT owner_member_id FROM items WHERE name = 'eggs' AND cost_source = 'receipt'").get();
    expect(eggsRow).toEqual({ owner_member_id: null });
  });

  test("the buyer pays nothing when the rest is split between others", async () => {
    setNow(T0);
    const { db, say } = await app(async () => TJ);
    await say(PHONES[0]!, "", true);
    await say(PHONES[0]!, "Sam paid, split between me and Jordan");
    await say(PHONES[0]!, "yes");
    const sam = db.query<{ s: number }, []>("SELECT share_cents AS s FROM expense_shares WHERE member_id = 2").get();
    expect(sam?.s ?? 0).toBe(0);
    expect(balancesFor(db, 1, 2).netCents).toBe(2010);
  });

  test("a video in the group gets no reply", async () => {
    setNow(T0);
    const { say } = await app(async () => {
      throw new ReceiptError("not_image");
    });
    expect(await say(PHONES[0]!, "", true)).toBe("");
  });

  test("a second identical receipt the same day asks before saving", async () => {
    setNow(T0);
    const { db, say } = await app(async () => TJ);
    await say(PHONES[0]!, "", true);
    await say(PHONES[0]!, "yes");
    await say(PHONES[0]!, "", true);
    expect(await say(PHONES[0]!, "yes")).toContain("Is this a second trip?");
    expect(db.query("SELECT COUNT(*) AS n FROM expenses").get()).toEqual({ n: 1 });
    expect(await say(PHONES[0]!, "yes, second trip")).toContain("Saved: $20.10");
    expect(db.query("SELECT COUNT(*) AS n FROM expenses").get()).toEqual({ n: 2 });
  });

  test("a mismatch is shown, and 'total is $X' fixes it", async () => {
    setNow(T0);
    const { db, say } = await app(async () => ({ ...TJ, total: "21.10" }));
    expect(await say(PHONES[0]!, "", true)).toContain("the lines add up to $20.10, but the total says $21.10");
    expect(await say(PHONES[0]!, "total is $20.10")).not.toContain("Heads up");
    await say(PHONES[0]!, "yes");
    expect(db.query("SELECT total_cents FROM expenses").get()).toEqual({ total_cents: 2010 });
  });

  test("caption on the photo sets the buyer; cancel saves nothing", async () => {
    setNow(T0);
    const { db, say } = await app(async () => TJ);
    expect(await say(PHONES[0]!, "Jordan paid", true)).toContain("Paid by Jordan.");
    expect(await say(PHONES[0]!, "cancel")).toContain("Nothing was saved");
    expect(db.query("SELECT COUNT(*) AS n FROM expenses").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM items WHERE cost_source = 'receipt'").get()).toEqual({ n: 0 });
  });

  test("errors give a friendly reply and save nothing; a non-receipt photo in the group gets no reply", async () => {
    setNow(T0);
    const failing = await app(async () => {
      throw new ReceiptError("timeout");
    });
    expect(await failing.say(PHONES[0]!, "", true)).toContain("took too long");
    expect(getPendingReceipt(failing.db, 1)).toBeNull();

    const meme = await app(async () => ({ items: [{ name: "VISA", price: "1" }], total: "1" }));
    expect(await meme.say(PHONES[0]!, "", true)).toBe("");

    const off = await app(async () => TJ, { client: false });
    expect(await off.say(PHONES[0]!, "", true)).toContain("when the AI is on");
  });
});
