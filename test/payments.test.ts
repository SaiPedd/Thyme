import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { describeToolResult, parseIntent, runFallback } from "../src/agent/fallback";
import { runTool, type ToolContext } from "../src/agent/tools";
import { getHousehold, getMembers } from "../src/domain/household";
import { paymentMethods } from "../src/domain/payments";
import { setupHousehold } from "./helpers";

// Alex = 0, Sam = 1, Jordan = 2.
function ctxFor(db: Database, memberIndex: number, isGroup: boolean, text?: string): ToolContext {
  const members = getMembers(db, 1);
  return { db, household: getHousehold(db)!, members, member: members[memberIndex]!, isGroup, messageId: crypto.randomUUID(), drafts: [], text };
}

/** Alex paid $30, so Sam and Jordan each owe Alex $10. */
function withDebt() {
  const db = setupHousehold();
  runTool("record_expense", { total: "$30" }, ctxFor(db, 0, true));
  return db;
}

const say = (db: Database, who: number, isGroup: boolean, text: string) => {
  const ctx = ctxFor(db, who, isGroup, text);
  return runFallback(text, ctx).then((reply) => ({ reply, ctx }));
};

describe("parsing payment info", () => {
  test("keeps the handle exactly as typed", () => {
    expect(parseIntent("Pay me through Zelle at dharaniDevadiga")).toEqual({ kind: "pay_save", method: "Zelle", handle: "dharaniDevadiga" });
    expect(parseIntent("my venmo is @dharani")).toEqual({ kind: "pay_save", method: "venmo", handle: "@dharani" });
    expect(parseIntent("you can pay me via cash app $dharani")).toEqual({ kind: "pay_save", method: "cash app", handle: "$dharani" });
    expect(parseIntent("pay me back on paypal: dharani@example.com")).toEqual({ kind: "pay_save", method: "paypal", handle: "dharani@example.com" });
    expect(parseIntent("remove my venmo")).toEqual({ kind: "pay_remove", method: "venmo" });
    expect(parseIntent("what's my payment info?")).toEqual({ kind: "pay_show" });
  });

  test("doesn't swallow other messages", () => {
    expect(parseIntent("I paid $30 for groceries")?.kind).toBe("expense");
    expect(parseIntent("what do I owe?")).toEqual({ kind: "balances" });
  });
});

describe("what do I owe shows how to pay", () => {
  test("the person you owe's handle is next to the amount", async () => {
    const db = withDebt();
    await say(db, 0, false, "pay me through Zelle at dharaniDevadiga");
    const { reply } = await say(db, 1, false, "what do I owe?");
    expect(reply).toContain("you owe Alex $10.00 (pay with Zelle: dharaniDevadiga)");
    // The person who is owed doesn't see handles.
    const alex = await say(db, 0, false, "what do I owe?");
    expect(alex.reply).toContain("Sam owes you $10.00");
    expect(alex.reply).not.toContain("Zelle");
  });

  test("several apps are all shown; saving the same app again replaces it", async () => {
    const db = withDebt();
    await say(db, 0, false, "pay me through Zelle at oldHandle");
    await say(db, 0, false, "pay me through Zelle at dharaniDevadiga");
    const venmo = await say(db, 0, false, "my Venmo is @dharani");
    expect(venmo.reply).toContain("All your payment info: Zelle: dharaniDevadiga, Venmo: @dharani.");
    const { reply } = await say(db, 2, false, "what do I owe");
    expect(reply).toContain("(pay with Zelle: dharaniDevadiga, Venmo: @dharani)");
    expect(reply).not.toContain("oldHandle");
  });

  test("no saved info: just the amount", async () => {
    const db = withDebt();
    const { reply } = await say(db, 1, false, "what do I owe?");
    expect(reply).toContain("you owe Alex $10.00");
    expect(reply).not.toContain("pay with");
  });
});

describe("privacy", () => {
  test("set in the group: saved, confirmed by DM, the handle isn't repeated in the group", async () => {
    const db = withDebt();
    const { reply, ctx } = await say(db, 0, true, "pay me through Zelle at dharaniDevadiga");
    expect(reply).toBe("Saved. I DM'd you the details.");
    expect(ctx.drafts).toHaveLength(1);
    expect(ctx.drafts[0]).toMatchObject({ audience: { kind: "member", memberId: 1 }, sensitivity: "personal" });
    expect(ctx.drafts[0]!.text).toContain("Zelle: dharaniDevadiga");
    expect(paymentMethods(db, 1)).toEqual([{ method: "Zelle", handle: "dharaniDevadiga" }]);
  });

  test("balances asked in the group go to the DM, handles included there only", async () => {
    const db = withDebt();
    await say(db, 0, false, "pay me through Zelle at dharaniDevadiga");
    const { reply, ctx } = await say(db, 1, true, "what do I owe?");
    expect(reply).not.toContain("dharani");
    expect(ctx.drafts[0]!.text).toContain("(pay with Zelle: dharaniDevadiga)");
  });

  test("the model can't save a handle the person didn't type", () => {
    const db = setupHousehold();
    const r = runTool("save_payment_method", { method: "Zelle", handle: "dharaniDevadigaa" }, ctxFor(db, 0, false, "pay me on zelle at dharaniDevadiga"));
    expect(r).toMatchObject({ saved: false });
    expect(paymentMethods(db, 1)).toEqual([]);
  });

  test("unknown apps and empty handles are refused", () => {
    const db = setupHousehold();
    expect(runTool("save_payment_method", { method: "Bitcoin", handle: "x" }, ctxFor(db, 0, false, "x"))).toMatchObject({ saved: false });
    expect(runTool("save_payment_method", { method: "Venmo", handle: "" }, ctxFor(db, 0, false, "my venmo"))).toMatchObject({ saved: false });
  });
});

describe("removing and forgetting", () => {
  test("remove one app", async () => {
    const db = withDebt();
    await say(db, 0, false, "pay me through Zelle at dharaniDevadiga");
    await say(db, 0, false, "my venmo is @dharani");
    expect((await say(db, 0, false, "remove my venmo")).reply).toBe("Removed your Venmo payment info.");
    expect(paymentMethods(db, 1)).toEqual([{ method: "Zelle", handle: "dharaniDevadiga" }]);
    expect((await say(db, 0, false, "remove my paypal")).reply).toBe("You didn't have PayPal saved.");
  });

  test("forget me deletes payment info too", async () => {
    const db = withDebt();
    await say(db, 0, false, "pay me through Zelle at dharaniDevadiga");
    const { reply } = await say(db, 0, false, "forget me");
    expect(reply).toContain("payment info");
    expect(paymentMethods(db, 1)).toEqual([]);
  });

  test("show my own payment info", async () => {
    const db = setupHousehold();
    expect((await say(db, 0, false, "my payment info")).reply).toContain("haven't saved any");
    await say(db, 0, false, "pay me through Zelle at dharaniDevadiga");
    expect((await say(db, 0, false, "my payment info")).reply).toBe("Roommates who owe you see: Zelle: dharaniDevadiga.");
    expect(describeToolResult("get_payment_methods", { sent_privately: true })).toBe("I DM'd you your payment info.");
  });
});
