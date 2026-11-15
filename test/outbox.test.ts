import { afterEach, describe, expect, test } from "bun:test";
import { resetClock, setNow } from "../src/clock";
import { Outbox } from "../src/outbox";
import { PrivacyError } from "../src/privacy/projection";
import { FakeAdapter, quietLog, setupHousehold } from "./helpers";

afterEach(() => resetClock());

// 2026-11-14 is EST (UTC-5): 15:00 local = 20:00Z, 23:00 local = 04:00Z next day.
const AFTERNOON = new Date("2026-11-14T20:00:00Z");
const NIGHT = new Date("2026-11-15T04:00:00Z");

const shared = { audience: { kind: "group" as const }, text: "spinach expires tomorrow", sensitivity: "household" as const };

function make() {
  const db = setupHousehold();
  const adapter = new FakeAdapter();
  const outbox = new Outbox(db, adapter, { sleep: async () => {}, log: quietLog });
  return { db, adapter, outbox };
}

describe("no quiet hours", () => {
  test("a proactive send at 11 PM goes out right away", async () => {
    const { adapter, outbox } = make();
    setNow(NIGHT);
    expect((await outbox.send(shared, { kind: "proactive" }))[0]!.status).toBe("accepted");
    expect(adapter.sent[0]!.text).toBe("spinach expires tomorrow");
  });

  test("a message an older run held back is still sent when due", async () => {
    const { db, adapter, outbox } = make();
    setNow(NIGHT);
    db.run(
      `INSERT INTO sends (id, audience, chat_id, kind, status, not_before, created_at, body) VALUES ('old', 'group', 'chat-1', 'proactive', 'deferred', ?, ?, 'held')`,
      [NIGHT.toISOString(), NIGHT.toISOString()],
    );
    expect((await outbox.flushDue())[0]!.status).toBe("accepted");
    expect(adapter.sent[0]!.text).toBe("held");
  });
});

describe("caps and budget", () => {
  test("daily cap on proactive group messages", async () => {
    const { outbox } = make();
    setNow(AFTERNOON);
    for (let i = 0; i < 4; i++) expect((await outbox.send(shared, { kind: "proactive" }))[0]!.status).toBe("accepted");
    expect((await outbox.send(shared, { kind: "proactive" }))[0]!).toMatchObject({ status: "refused", reason: "daily cap" });
    // Replies are not capped.
    expect((await outbox.send(shared, { kind: "reply" }))[0]!.status).toBe("accepted");
  });

  test("refuses proactive sends above 90% of the monthly budget", async () => {
    const db = setupHousehold();
    const adapter = new FakeAdapter();
    const outbox = new Outbox(db, adapter, { monthlyBudget: 10, sleep: async () => {}, log: quietLog });
    setNow(AFTERNOON);
    for (let i = 0; i < 9; i++) outbox.recordInbound();
    expect((await outbox.send(shared, { kind: "proactive" }))[0]!).toMatchObject({ status: "refused", reason: "budget" });
    expect((await outbox.send(shared, { kind: "reply" }))[0]!.status).toBe("accepted");
    expect(outbox.usage()).toMatchObject({ inbound: 9, outbound: 1 });
  });
});

describe("delivery", () => {
  test("retries retryable failures and honors Retry-After", async () => {
    const db = setupHousehold();
    const adapter = new FakeAdapter();
    const waits: number[] = [];
    const outbox = new Outbox(db, adapter, { sleep: async (ms) => void waits.push(ms), log: quietLog });
    adapter.results = [
      { ok: false, status: "rate_limited", retryAfterMs: 2000 },
      { ok: false, status: "failed", retryable: true },
      { ok: true, status: "accepted", messageId: "m9" },
    ];
    expect((await outbox.send(shared, { kind: "reply" }))[0]!.status).toBe("accepted");
    expect(adapter.sent).toHaveLength(3);
    expect(waits).toEqual([2000, 1000]);
    const row = db.query<{ status: string; attempts: number; message_id: string }, []>("SELECT status, attempts, message_id FROM sends").get()!;
    expect(row).toEqual({ status: "accepted", attempts: 3, message_id: "m9" });
  });

  test("non-retryable failure stops immediately; accepted is not delivered until a status event", async () => {
    const { db, adapter, outbox } = make();
    adapter.results = [{ ok: false, status: "failed", retryable: false, error: "blocked" }];
    expect((await outbox.send(shared, { kind: "reply" }))[0]!.status).toBe("failed");
    expect(adapter.sent).toHaveLength(1);

    await outbox.send(shared, { kind: "reply" });
    const status = () => db.query<{ status: string }, []>("SELECT status FROM sends WHERE message_id IS NOT NULL").get()!.status;
    expect(status()).toBe("accepted");
    outbox.markStatus({ messageId: adapter.sent.length ? "m-2" : "", status: "delivered" });
    expect(status()).toBe("delivered");
  });

  test("personal content to the group is refused before anything is sent", async () => {
    const { adapter, outbox } = make();
    expect(
      outbox.send({ audience: { kind: "group" }, text: "Alex owes $13", sensitivity: "personal", subjectMemberId: 1 }, { kind: "reply" }),
    ).rejects.toThrow(PrivacyError);
    expect(adapter.sent).toHaveLength(0);
  });
});
