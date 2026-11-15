import { describe, expect, test } from "bun:test";
import { amountsAreGrounded, claimsPrivateSend, durationsAreGrounded, MAX_TOOL_ITERATIONS, runAgent, type AgentInput, type GeminiInteraction } from "../src/agent/loop";
import { parseIntent } from "../src/agent/fallback";
import { runTool, toolDefinitions, type ToolContext } from "../src/agent/tools";
import { loadShelfLife, parseFoodKeeper } from "../src/domain/foodkeeper";
import { getHousehold, getMembers } from "../src/domain/household";
import { setupHousehold } from "./helpers";

function ctx(isGroup = true): ToolContext {
  const db = setupHousehold();
  const household = getHousehold(db)!;
  const members = getMembers(db, 1);
  return { db, household, members, member: members[0]!, isGroup, messageId: "m1", drafts: [] };
}

type Scripted = GeminiInteraction | Error | "hang";

/** A scripted stand-in for the Gemini Interactions client. */
function fakeClient(responses: Scripted[] | ((call: number) => Scripted)) {
  const calls: { params: any; options: any }[] = [];
  return {
    calls,
    client: {
      interactions: {
        create: async (params: any, options: any) => {
          calls.push({ params: structuredClone(params), options });
          const r = typeof responses === "function" ? responses(calls.length) : responses[calls.length - 1]!;
          if (r instanceof Error) throw r;
          if (r === "hang") return new Promise<GeminiInteraction>(() => {});
          return r;
        },
      },
    } satisfies AgentInput["client"],
  };
}

const text = (t: string): GeminiInteraction => ({
  status: "completed",
  output_text: t,
  steps: [{ type: "model_output", content: [{ type: "text", text: t }] }],
});
const call = (name: string, args: unknown, id = "fc1"): GeminiInteraction => ({
  status: "requires_action",
  steps: [
    { type: "thought", signature: "sig-1" },
    { type: "function_call", id, name, arguments: args },
  ],
});

const base = (c: ToolContext, client: AgentInput["client"], t: string): AgentInput => ({
  text: t,
  ctx: c,
  history: [],
  botName: "Fridge Squad",
  model: "gemini-3.5-flash-lite",
  localDate: "2026-11-14",
  client,
});

describe("tool definitions", () => {
  test("Gemini function tools, without additionalProperties", () => {
    const defs = toolDefinitions();
    expect(defs.every((d) => d.type === "function" && d.name && d.parameters)).toBe(true);
    expect(JSON.stringify(defs)).not.toContain("additionalProperties");
  });
});

describe("fallback parser", () => {
  test("core patterns", () => {
    expect(parseIntent("groceries were $48.60, split 3 ways, chicken thighs ($9) are just mine")).toEqual({
      kind: "expense",
      total: "$48.60",
      ways: 3,
      mineItems: [{ description: "chicken thighs", amount: "$9" }],
    });
    expect(parseIntent("got chicken, spinach and rice")).toEqual({ kind: "add", items: [{ name: "chicken" }, { name: "spinach" }, { name: "rice" }] });
    expect(parseIntent("used the last of the rice")).toEqual({ kind: "use", item: "rice" });
    expect(parseIntent("tossed the milk")).toEqual({ kind: "toss", item: "milk" });
    expect(parseIntent("undo")).toEqual({ kind: "undo" });
    expect(parseIntent("Fridge Squad, what do I owe?", "Fridge Squad")).toEqual({ kind: "balances" });
    expect(parseIntent("lol see you at 8")).toBeNull();
  });
});

describe("agent loop (Gemini)", () => {
  test("function call, then a grounded reply; steps echoed and results matched by call id", async () => {
    const c = ctx();
    const { client, calls } = fakeClient([
      call("record_expense", { total: "$48.60", items: [{ description: "chicken thighs", amount: "$9", members: ["me"] }] }),
      text("Logged $48.60. Alex $22.20, Sam $13.20, Jordan $13.20. Say undo to fix."),
    ]);
    const r = await runAgent(base(c, client, "groceries were $48.60, split 3 ways, chicken thighs ($9) are just mine"));
    expect(r.source).toBe("gemini");
    expect(r.toolCalls).toEqual(["record_expense"]);

    const first = calls[0]!.params;
    expect(first).toMatchObject({ model: "gemini-3.5-flash-lite", store: false, automatic_continuation: false });
    expect(first.system_instruction).toContain("Fridge Squad");
    expect(first.input[0].type).toBe("user_input");

    const second = calls[1]!.params.input;
    // The model's steps (incl. the thought signature) come back unchanged, then the result.
    expect(second[1]).toEqual({ type: "thought", signature: "sig-1" });
    expect(second[2]).toMatchObject({ type: "function_call", id: "fc1" });
    expect(second[3]).toMatchObject({ type: "function_result", call_id: "fc1", name: "record_expense" });
    expect(JSON.parse(second[3].result[0].text)).toMatchObject({ recorded: true, total: "$48.60" });
    expect(calls[0]!.options.signal).toBeInstanceOf(AbortSignal);
  });

  test("a reply with a dollar amount no tool produced is rejected", async () => {
    const c = ctx();
    const { client } = fakeClient([call("record_expense", { total: "$30" }), text("Done! Everyone owes $15.00.")]);
    const r = await runAgent(base(c, client, "spent $30 on groceries"));
    expect(r.source).toBe("tools");
    expect(r.reply).toContain("Logged $30.00");
    expect(r.reply).not.toContain("$15.00");
  });

  test("when Gemini fails after a tool ran, the action is not applied twice", async () => {
    const c = ctx();
    const { client } = fakeClient([call("record_expense", { total: "$30" }), new Error("boom")]);
    const r = await runAgent(base(c, client, "groceries $30 split 3 ways"));
    expect(r.source).toBe("tools");
    expect(c.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM expenses").get()!.n).toBe(1);
  });

  test("errors before any tool, empty replies, failed status, and LLM off all use the rules", async () => {
    expect((await runAgent(base(ctx(), fakeClient([new Error("network")]).client, "groceries were $12 split 3 ways"))).source).toBe("fallback");
    const empty = await runAgent(base(ctx(), fakeClient([{ status: "completed", output_text: "", steps: [] }]).client, "undo"));
    expect(empty).toMatchObject({ source: "fallback", note: "empty reply" });
    const failed = await runAgent(base(ctx(), fakeClient([{ status: "failed", steps: [] }]).client, "undo"));
    expect(failed).toMatchObject({ source: "fallback", note: "status failed" });
    expect((await runAgent(base(ctx(), null, "undo"))).reply).toBe("There's nothing of yours to undo.");
  });

  test("stops after the max number of tool rounds", async () => {
    const { client, calls } = fakeClient((n) => call("get_household_summary", {}, `fc${n}`));
    const r = await runAgent(base(ctx(), client, "who lives here?"));
    expect(calls.length).toBe(MAX_TOOL_ITERATIONS + 1);
    expect(r.note).toBe("too many tool calls");
  });

  test("a hung request hits the deadline and falls back", async () => {
    const { client } = fakeClient(() => "hang");
    const started = performance.now();
    const r = await runAgent({ ...base(ctx(), client, "undo"), timeoutMs: 300 });
    expect(r).toMatchObject({ note: "timeout", source: "fallback", reply: "There's nothing of yours to undo." });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("in a group, balances go to a private DM, not to the model", async () => {
    const c = ctx(true);
    const { client, calls } = fakeClient([call("get_balances", {}), text("I DM'd you your balance.")]);
    const r = await runAgent(base(c, client, "am I behind on paying Sam back?"));
    expect(r.reply).toBe("I DM'd you your balance.");
    expect(JSON.stringify(calls[1]!.params.input.at(-1))).toContain("sent_privately");
    expect(c.drafts).toHaveLength(1);
    expect(c.drafts[0]).toMatchObject({ audience: { kind: "member", memberId: 1 }, sensitivity: "personal", subjectMemberId: 1 });
  });

  test("fact questions (fridge, balances, waste) are answered by code, never by the model", async () => {
    for (const q of ["what is in my fridge?", "what do I owe?", "how much have we wasted?"]) {
      const c = ctx(true);
      const { client, calls } = fakeClient([text("We have caviar and lobster!")]);
      const r = await runAgent(base(c, client, q));
      expect(calls).toHaveLength(0);
      expect(r).toMatchObject({ source: "fallback", note: "fact question" });
      expect(r.reply).not.toContain("caviar");
    }
  });

  test("a reply claiming a DM that was never sent is rejected", async () => {
    const c = ctx(true);
    const { client } = fakeClient([text("I just sent your inventory details to your DMs!")]);
    const r = await runAgent(base(c, client, "anything good to snack on"));
    expect(r.note).toBe("claimed a DM that wasn't sent");
    expect(r.reply ?? "").not.toContain("DM");
    expect(c.drafts).toHaveLength(0);
  });

  test("history is sent as plain text inside the user turn", async () => {
    const { client, calls } = fakeClient([text("Hi!")]);
    await runAgent({ ...base(ctx(), client, "hey"), history: [{ role: "user", content: "Sam: hi" }, { role: "assistant", content: "Hello Sam" }] });
    const sent = calls[0]!.params.input;
    expect(sent).toHaveLength(1);
    expect(sent[0].content[0].text).toContain("Fridge Squad: Hello Sam");
  });
});

describe("shelf life facts come from USDA, not the model", () => {
  const fixture = {
    sheets: [
      { name: "Category", data: [[{ ID: 1 }, { Category_Name: "Grains" }]] },
      {
        name: "Product",
        data: [[{ ID: 7 }, { Category_ID: 1 }, { Name: "Rice" }, { Name_subtitle: "cooked" }, { Refrigerate_Min: 4 }, { Refrigerate_Max: 6 }, { Refrigerate_Metric: "Days" }]],
      },
    ],
  };

  test("shelf_life_lookup returns the USDA day ranges", () => {
    const c = ctx();
    loadShelfLife(c.db, parseFoodKeeper(fixture));
    const r = runTool("shelf_life_lookup", { query: "cooked rice" }, c) as any;
    expect(r.matches[0]).toMatchObject({ food: "Rice (cooked)", fridge: "4-6 days", pantry: "not listed" });
  });

  test("a duration the tool didn't return is rejected; the USDA template answers instead", async () => {
    const c = ctx(false);
    loadShelfLife(c.db, parseFoodKeeper(fixture));
    const { client } = fakeClient([call("shelf_life_lookup", { query: "cooked rice" }), text("Cooked rice lasts about 7 days.")]);
    const r = await runAgent(base(c, client, "how long does cooked rice last?"));
    expect(r).toMatchObject({ source: "tools", note: "ungrounded duration" });
    expect(r.reply).toContain("fridge 4-6 days");
  });

  test("durationsAreGrounded", () => {
    expect(durationsAreGrounded("lasts 4 to 6 days", ['{"fridge":"4-6 days"}'])).toBe(true);
    expect(durationsAreGrounded("lasts 7 days", ['{"fridge":"4-6 days"}'])).toBe(false);
    expect(durationsAreGrounded("eat it soon", [])).toBe(true);
  });
});

describe("claimsPrivateSend", () => {
  test("spots claims of a private message", () => {
    for (const s of ["I sent your balance to your DMs", "I DM'd you", "I've sent your inventory privately!", "Texted you a private message"]) {
      expect(claimsPrivateSend(s)).toBe(true);
    }
    for (const s of ["Balances are private.", "Ask me in a DM for your balance.", "Logged $48.60."]) expect(claimsPrivateSend(s)).toBe(false);
  });
});

describe("amountsAreGrounded", () => {
  test("allows amounts from tools or the user, nothing else", () => {
    expect(amountsAreGrounded("Logged $48.60", ['{"total":"$48.60"}'])).toBe(true);
    expect(amountsAreGrounded("It was $9", ["chicken ($9) is mine"])).toBe(true);
    expect(amountsAreGrounded("That's $16.20 each", ['{"total":"$48.60"}'])).toBe(false);
    expect(amountsAreGrounded("no money here", [])).toBe(true);
  });
});
