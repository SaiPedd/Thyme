// Claims arbitration and the 3-day fake-clock scenario: reminders, one retry, claims, quiet hours.

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { runTool, type ToolContext } from "../src/agent/tools";
import { addDays, advance, advanceDays, now, resetClock, setNow } from "../src/clock";
import { claimItem } from "../src/domain/claims";
import { importFoodKeeperFile } from "../src/domain/foodkeeper";
import { getHousehold, getMembers } from "../src/domain/household";
import { addItem } from "../src/domain/inventory";
import { Inbox } from "../src/inbox";
import { Outbox } from "../src/outbox";
import { makeRouter } from "../src/router";
import { groupReminderText, Scheduler } from "../src/scheduler";
import { FakeAdapter, PHONES, quietLog, setupHousehold } from "./helpers";

// 10:00 in New York.
const T0 = new Date("2026-11-14T15:00:00Z");
const tick = () => new Promise((r) => setTimeout(r, 30));

afterEach(() => resetClock());

async function app() {
  const db = setupHousehold();
  await importFoodKeeperFile(db);
  db.run("INSERT INTO state (key, value) VALUES ('intro:chat-1', 't')");
  const adapter = new FakeAdapter();
  const outbox = new Outbox(db, adapter, { sleep: async () => {}, log: quietLog });
  const router = makeRouter({ db, outbox, adapter, botName: "Thyme", model: "x", client: null, log: quietLog });
  const inbox = new Inbox(db, router, { debounceMs: 5 });
  await adapter.start({ onMessage: (m) => inbox.push(m) });
  const scheduler = new Scheduler(db, outbox, { log: quietLog });
  return { db, adapter, inbox, scheduler };
}

function add(db: Database, name: string, ownerId: number | null = null) {
  const r = addItem(db, { householdId: 1, name, buyerId: 1, ownerId, state: "raw" });
  if (!r.ok) throw new Error(`couldn't add ${name}`);
  return r.item;
}

function ctxFor(db: Database, memberIndex: number, extra: Partial<ToolContext> = {}): ToolContext {
  const members = getMembers(db, 1);
  return { db, household: getHousehold(db)!, members, member: members[memberIndex]!, isGroup: true, drafts: [], ...extra };
}

describe("claim arbitration", () => {
  test("first claim by sentAt wins; the later one is told who won", async () => {
    const { db } = await app();
    const item = add(db, "spinach");
    expect(claimItem(db, item.id, 2, "a", "2026-11-14T15:00:01.000Z")).toEqual({ won: true, winnerMemberId: 2 });
    expect(claimItem(db, item.id, 3, "b", "2026-11-14T15:00:05.000Z")).toEqual({ won: false, winnerMemberId: 2 });
    expect(claimItem(db, item.id, 2, "c", "2026-11-14T15:00:09.000Z")).toMatchObject({ won: true, repeat: true });
    expect(db.query("SELECT COUNT(*) AS n FROM claims WHERE won = 1").get()).toEqual({ n: 1 });
  });

  test("an earlier claim that arrives late takes over, and the group is told", async () => {
    const { db } = await app();
    add(db, "spinach");
    const sam = ctxFor(db, 1, { sentAt: "2026-11-14T15:00:05Z", messageId: "s" });
    expect(runTool("claim_item", { item: "spinach" }, sam)).toMatchObject({ claimed: true, winner: "Sam" });
    const jordan = ctxFor(db, 2, { sentAt: "2026-11-14T15:00:02Z", messageId: "j" });
    expect(runTool("claim_item", { item: "spinach" }, jordan)).toMatchObject({ claimed: true, winner: "Jordan" });
    expect(jordan.drafts).toHaveLength(1);
    expect(jordan.drafts[0]).toMatchObject({ audience: { kind: "group" }, sensitivity: "household" });
    expect(jordan.drafts[0]!.text).toContain("Jordan asked first");
  });

  test("past-date items can't be claimed, and personal items aren't claimable", async () => {
    const { db } = await app();
    setNow(T0);
    add(db, "strawberries");
    add(db, "chicken thighs", 1);
    advanceDays(5);
    expect(runTool("claim_item", { item: "strawberries" }, ctxFor(db, 1))).toMatchObject({ claimed: false, past_usda_date: true });
    expect(runTool("claim_item", { item: "chicken" }, ctxFor(db, 1))).toMatchObject({ claimed: false });
  });
});

describe("3-day fake-clock scenario", () => {
  test("reminders, one retry, claims over chat, then silence", async () => {
    const { db, adapter, inbox, scheduler } = await app();
    setNow(T0);
    const spinach = add(db, "spinach"); // fridge, 3 days -> at risk from day 1
    add(db, "chicken thighs", 1); // Alex's, 1 day
    add(db, "eggs"); // 21 days, never reminded here

    // Day 0, 10:00: only Alex's chicken is within 48h; it goes to Alex's DM, not the group.
    let r = await scheduler.tick();
    expect(r?.groupItems).toEqual([]);
    expect(Object.keys(r!.memberItems)).toEqual(["1"]);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.destination).toEqual({ kind: "member", phone: PHONES[0]! });
    expect(adapter.sent[0]!.text).toContain("chicken thighs expire tomorrow");
    // Same day again: nothing new.
    expect(await scheduler.tick()).toBeNull();

    // Day 1: spinach now within 48h -> group; chicken is past its date -> the one retry, saying toss it.
    advanceDays(1);
    r = await scheduler.tick();
    expect(r?.groupItems).toEqual([spinach.id]);
    const group = adapter.sent.filter((s) => s.destination.kind === "group");
    expect(group).toHaveLength(1);
    expect(group[0]!.text).toContain("spinach expires in 2 days");
    expect(group[0]!.text).not.toContain("chicken");
    expect(adapter.sent.at(-1)!.text).toContain("past the USDA FoodKeeper date");

    // Sam says "mine" in the group, then Jordan does: Sam wins, Jordan hears who won.
    advance(60_000);
    adapter.receive({ from: PHONES[1]!, text: "mine", sentAt: now().toISOString() });
    await tick();
    advance(1000);
    adapter.receive({ from: PHONES[2]!, text: "mine!", sentAt: now().toISOString() });
    await tick();
    await inbox.drain();
    const replies = adapter.sent.slice(-2).map((s) => s.text);
    expect(replies[0]).toContain("spinach is yours");
    expect(replies[1]).toContain("Sam already claimed the spinach");

    // Day 2 and 3: claimed spinach gets no retry; chicken already had its one retry; eggs aren't close.
    const before = adapter.sent.length;
    advanceDays(1);
    expect((await scheduler.tick())?.groupItems ?? []).toEqual([]);
    advanceDays(1);
    await scheduler.tick();
    expect(adapter.sent.length).toBe(before);
    expect(db.query("SELECT COUNT(*) AS n FROM nudges").get()).toEqual({ n: 3 });
  });

  test("an unanswered shared reminder gets exactly one retry the next morning", async () => {
    const { db, adapter, scheduler } = await app();
    setNow(addDays(T0, 0));
    add(db, "strawberries"); // 2 days
    await scheduler.tick();
    advanceDays(1);
    await scheduler.tick();
    advanceDays(1);
    await scheduler.tick();
    const group = adapter.sent.filter((s) => s.destination.kind === "group").map((s) => s.text);
    expect(group).toHaveLength(2);
    expect(group[0]).toMatch(/^Heads up/);
    expect(group[1]).toMatch(/^Reminder/);
  });

  test("nothing before 09:00; reminders wait for the morning run", async () => {
    const { db, adapter, scheduler } = await app();
    setNow(new Date("2026-11-14T12:00:00Z")); // 07:00 in New York
    add(db, "strawberries");
    expect(await scheduler.tick()).toBeNull();
    expect(adapter.sent).toHaveLength(0);
    advance(2 * 3_600_000); // 09:00
    expect((await scheduler.tick())?.groupItems).toHaveLength(1);
  });

  test("a reminder refused by the daily cap isn't recorded, so it goes out the next day", async () => {
    const db = setupHousehold();
    await importFoodKeeperFile(db);
    const adapter = new FakeAdapter();
    const outbox = new Outbox(db, adapter, { sleep: async () => {}, log: quietLog, caps: { memberPerDay: 0, groupPerDay: 0 } });
    const scheduler = new Scheduler(db, outbox, { log: quietLog });
    setNow(T0);
    add(db, "strawberries");
    expect((await scheduler.tick())?.groupItems).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM nudges").get()).toEqual({ n: 0 });
  });
});

describe("reminder wording", () => {
  test("several past-date items: only the first word is capitalized", async () => {
    const db = setupHousehold();
    await importFoodKeeperFile(db);
    setNow(T0);
    const items = [add(db, "chicken"), add(db, "strawberries")];
    advanceDays(5);
    expect(groupReminderText(items, "America/New_York", false)).toBe(
      'The chicken and the strawberries are past the USDA FoodKeeper date. To be safe, toss them and tell me "tossed the chicken".',
    );
  });
});
