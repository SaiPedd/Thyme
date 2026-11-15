// Rule-based fallback (LLM=off, no key, timeout, or failure). Handles the core patterns:
// "got X, Y", "used the X", "tossed X", "groceries $N split K ways", "undo", "what do I owe".
// Uses the same tools as the agent, so facts come from code either way.

import { runTool, type ToolContext } from "./tools";

export type Intent =
  | { kind: "expense"; total: string; ways?: number; mineItems: { description: string; amount: string }[] }
  | { kind: "undo" }
  | { kind: "balances" }
  | { kind: "add"; items: string[] }
  | { kind: "use"; item: string }
  | { kind: "toss"; item: string };

const WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };

function splitList(s: string): string[] {
  return s
    .split(/,|\band\b|&|\+/i)
    .map((x) => x.replace(/^\s*(some|a|an|the)\s+/i, "").replace(/[.!]+$/, "").trim())
    .filter(Boolean);
}

export function parseIntent(raw: string, botName = ""): Intent | null {
  let text = raw.trim();
  if (botName) text = text.replace(new RegExp(`^@?${botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[,:]?\\s*`, "i"), "");
  const t = text.toLowerCase();

  if (/^(undo|scratch that|nvm undo)\b/.test(t)) return { kind: "undo" };
  if (/\b(what do i owe|who owes me|my balance|balances?\??$)/.test(t)) return { kind: "balances" };

  const money = text.match(/\$\s?\d[\d,]*(?:\.\d{1,2})?/);
  if (money && /\b(groceries|grocery|spent|paid|bill|split|costco|trader joe'?s|target)\b/i.test(text)) {
    const ways = t.match(/split\s+(\d+|two|three|four|five|six)\s+ways?/);
    const mineItems: { description: string; amount: string }[] = [];
    for (const m of text.matchAll(/([a-z][a-z\s]*?)\s*\((\$\s?\d[\d,]*(?:\.\d{1,2})?)\)\s*(?:is|are)\s+(?:just\s+)?mine/gi)) {
      mineItems.push({ description: m[1]!.trim(), amount: m[2]! });
    }
    return {
      kind: "expense",
      total: money[0],
      ways: ways ? (WORDS[ways[1]!] ?? Number(ways[1])) : undefined,
      mineItems,
    };
  }

  let m = text.match(/^(?:i\s+)?(?:got|bought|picked up|grabbed)\s+(.+)/i);
  if (m) return { kind: "add", items: splitList(m[1]!) };
  m = text.match(/^(?:i\s+)?(?:used|finished|ate)\s+(?:up\s+)?(?:the\s+)?(?:last\s+of\s+(?:the\s+)?)?(.+)/i);
  if (m) return { kind: "use", item: m[1]!.replace(/[.!]+$/, "").trim() };
  m = text.match(/^(?:i\s+)?(?:tossed|threw out|threw away|binned|trashed)\s+(?:out\s+)?(?:the\s+)?(.+)/i);
  if (m) return { kind: "toss", item: m[1]!.replace(/[.!]+$/, "").trim() };
  return null;
}

/** Fixed wording for a tool's result. Used by the fallback, and by the agent if Claude fails mid-turn. */
export function describeToolResult(name: string, r: Record<string, any>): string | null {
  switch (name) {
    case "undo_last":
      return r.undone ? `Undone: the ${r.total} expense is removed.` : "There's nothing of yours to undo.";
    case "get_balances":
      if (r.sent_privately) return "I sent your balance to you privately.";
      return [`Your balance: ${r.net}.`, ...((r.breakdown as string[]) ?? [])].join("\n");
    case "record_expense": {
      if (r.duplicate) return "That looks like the same total you already logged today. Is it a second purchase?";
      if (!r.recorded) return `I couldn't log that: ${r.error ?? "unknown problem"}.`;
      const owes = (r.who_owes_whom as string[] | undefined) ?? [];
      return [`Logged ${r.total} paid by ${r.paid_by}.`, ...owes, `${r.payer_own_share}.`, `Reply "undo" to fix it.`].join("\n");
    }
    case "shelf_life_lookup": {
      const top = (r.matches as { food: string; pantry: string; fridge: string; freezer: string }[] | undefined)?.[0];
      if (!top) return "I couldn't find that food in the USDA FoodKeeper table. If you're unsure it's still good, toss it.";
      return `USDA FoodKeeper, ${top.food}: pantry ${top.pantry}, fridge ${top.fridge}, freezer ${top.freezer}. If you're unsure it's still good, toss it.`;
    }
    default:
      return null;
  }
}

/** Run the intent with the shared tools and word the reply with fixed templates. */
export function runFallback(text: string, ctx: ToolContext, botName = ""): string | null {
  const intent = parseIntent(text, botName);
  if (!intent) return null;

  switch (intent.kind) {
    case "undo":
      return describeToolResult("undo_last", runTool("undo_last", {}, ctx));
    case "balances":
      return describeToolResult("get_balances", runTool("get_balances", {}, ctx));
    case "expense": {
      if (intent.ways && intent.ways !== ctx.members.length) {
        return `Who's splitting it? The household has ${ctx.members.length} people (${ctx.members.map((m) => m.name).join(", ")}).`;
      }
      const r = runTool("record_expense", { total: intent.total, items: intent.mineItems.map((i) => ({ ...i, members: ["me"] })) }, ctx);
      return describeToolResult("record_expense", r);
    }
    case "add":
    case "use":
    case "toss":
      return "Got it. Fridge tracking is coming online soon, so I can't log food yet.";
  }
}
