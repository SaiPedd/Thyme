// record_expense only accepts roommates the sender actually named, so the model can't carry a person
// over from someone else's earlier message ("me" must mean the sender).

import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { runTool, type ToolContext } from "../src/agent/tools";
import { getHousehold, getMembers } from "../src/domain/household";
import { setupHousehold } from "./helpers";

function ctxFor(db: Database, memberIndex: number, mentionText?: string): ToolContext {
  const members = getMembers(db, 1);
  return { db, household: getHousehold(db)!, members, member: members[memberIndex]!, isGroup: true, messageId: crypto.randomUUID(), drafts: [], mentionText };
}

const jordanSaid = "groceries were $30, the $9 chicken is just me and Sam's, rest split with everyone";

describe("record_expense names must come from the sender", () => {
  test("rejects a roommate the sender never mentioned", () => {
    const db = setupHousehold();
    const r = runTool("record_expense", { total: "$30", items: [{ description: "chicken", amount: "$9", members: ["Alex", "Sam"] }] }, ctxFor(db, 2, jordanSaid));
    expect(String(r.error)).toContain("didn't mention Alex");
    expect(db.query("SELECT COUNT(*) AS n FROM expenses").get()).toEqual({ n: 0 });
  });

  test("accepts me plus people named in the message", () => {
    const db = setupHousehold();
    const r = runTool("record_expense", { total: "$30", items: [{ description: "chicken", amount: "$9", members: ["me", "Sam"] }] }, ctxFor(db, 2, jordanSaid));
    expect(r.recorded).toBe(true);
    expect(r.shares).toEqual([
      { name: "Alex", amount: "$7.00" },
      { name: "Sam", amount: "$11.50" },
      { name: "Jordan", amount: "$11.50" },
    ]);
  });

  test("the sender's own name and names from their earlier messages are fine", () => {
    const db = setupHousehold();
    const said = "who paid? me\nJordan: groceries $30 split with Alex";
    const r = runTool("record_expense", { total: "$30", split_among: ["Jordan", "Alex"] }, ctxFor(db, 2, said));
    expect(r.recorded).toBe(true);
  });

  test("no check when there's no message text (fallback path)", () => {
    const db = setupHousehold();
    const r = runTool("record_expense", { total: "$30", split_among: ["Alex"] }, ctxFor(db, 2));
    expect(r.recorded).toBe(true);
  });
});

describe("record_expense: everyone is fine", () => {
  test("a list naming the whole household counts as everyone", () => {
    const db = setupHousehold();
    const members = getMembers(db, 1);
    const ctx: ToolContext = { db, household: getHousehold(db)!, members, member: members[2]!, isGroup: true, drafts: [], mentionText: "groceries $30, the $9 chicken is me and Sam's, rest split with everyone" };
    const r = runTool("record_expense", { total: "$30", split_among: ["Alex", "Sam", "Jordan"], items: [{ description: "chicken", amount: "$9", members: ["me", "Sam"] }] }, ctx);
    expect(r.recorded).toBe(true);
  });
});
