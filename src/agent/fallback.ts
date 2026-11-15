// Rule-based fallback (LLM=off, no key, timeout, or failure). Handles the core patterns:
// "got X, Y", "used the X", "tossed X", "groceries $N split K ways", "undo", "what do I owe",
// "what's in the fridge", and claims ("mine", "I'll take the X").
// Uses the same tools as the agent, so facts come from code either way.

import { runTool, type ToolContext } from "./tools";
import { agree, isPlural } from "../domain/inventory";

export type Intent =
  | { kind: "expense"; total: string; ways?: number; mineItems: { description: string; amount: string }[] }
  | { kind: "undo" }
  | { kind: "balances" }
  | { kind: "add"; items: string[] }
  | { kind: "use"; item: string }
  | { kind: "toss"; item: string }
  | { kind: "inventory" }
  | { kind: "claim"; item?: string };

const WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };

/** Words that follow "got" but aren't food ("got it", "got home"). */
const NOT_FOOD = new Set(["it", "this", "that", "them", "you", "home", "back", "here", "there", "paid", "time", "one", "nothing", "everything"]);

function splitList(s: string): string[] {
  return s
    .split(/,|\band\b|&|\+/i)
    .map((x) => x.replace(/^\s*(some|a|an|the)\s+/i, "").replace(/[.!?]+$/, "").trim())
    .filter((x) => x && !NOT_FOOD.has(x.toLowerCase()));
}

const cleanItem = (s: string) => s.replace(/[.!?]+$/, "").trim();

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

  if (/\b(what'?s|what is|whats)\s+(in\s+(the\s+|our\s+)?(fridge|pantry|freezer|kitchen)|expiring|going bad)|\bwhat (food )?do we have\b|\binventory\b/.test(t)) {
    return { kind: "inventory" };
  }
  if (/^(mine|dibs|i'?ll take (it|them)|i want (it|them)|i'?ll have (it|them)|claim(ing)? (it|them))[\s!.]*$/.test(t)) return { kind: "claim" };
  let m = text.match(/^(?:i'?ll take|i will take|dibs on|i call|i'?ll eat|claiming|i want)\s+(?:the\s+)?(.+)/i);
  if (m) return { kind: "claim", item: cleanItem(m[1]!) };

  m = text.match(/^(?:i\s+)?(?:got|bought|picked up|grabbed)\s+(.+)/i);
  if (m) {
    const items = splitList(m[1]!);
    return items.length ? { kind: "add", items } : null;
  }
  m = text.match(/^(?:i\s+)?(?:used|finished|ate)\s+(?:up\s+)?(?:the\s+)?(?:last\s+of\s+(?:the\s+)?)?(.+)/i);
  if (m) return { kind: "use", item: cleanItem(m[1]!) };
  m = text.match(/^(?:i\s+)?(?:tossed|threw out|threw away|binned|trashed)\s+(?:out\s+)?(?:the\s+)?(.+)/i);
  if (m) return { kind: "toss", item: cleanItem(m[1]!) };
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
    case "add_item": {
      const lines: string[] = [];
      const added = (r.added as { item: string; status: string }[] | undefined) ?? [];
      if (added.length) lines.push(`Added ${added.map((a) => `${a.item} (${a.status})`).join(", ")}.`);
      if (r.personal_items_logged_privately) lines.push("I DM'd you the ones that are just yours.");
      for (const p of (r.problems as Record<string, any>[] | undefined) ?? []) {
        lines.push(p.needs_clarification ? `Is the ${p.item} raw or cooked?` : `I couldn't find "${p.item}" in the USDA FoodKeeper table. What kind of food is it?`);
      }
      return lines.join("\n") || "I didn't catch which food that was.";
    }
    case "use_item":
      if (!r.done) return `I don't see that in the fridge list.`;
      return r.rescued ? `Nice save! The ${r.item} was about to expire. Marked as used.` : `Marked the ${r.item} as used.`;
    case "log_toss":
      return r.done ? `Marked the ${r.item} as tossed.` : `I don't see that in the fridge list.`;
    case "get_inventory": {
      const fmt = (xs: { item: string; status: string }[]) => xs.map((x) => `- ${x.item}: ${x.status}`);
      const shared = (r.shared as { item: string; status: string }[] | undefined) ?? [];
      const yours = (r.yours as { item: string; status: string }[] | undefined) ?? [];
      if (!shared.length && !yours.length) return "Nothing's logged yet. Tell me what you bought, like \"got spinach and milk\".";
      return [
        ...(shared.length ? ["In the kitchen (soonest first):", ...fmt(shared)] : []),
        ...(yours.length ? ["Just yours:", ...fmt(yours)] : []),
      ].join("\n");
    }
    case "claim_item":
      if (r.claimed) {
        const [is, it] = isPlural(String(r.item)) ? ["are", "They"] : ["is", "It"];
        return r.note === "already theirs" ? `The ${r.item} ${is} already yours.` : `The ${r.item} ${is} yours! ${it} ${agree(String(r.item), String(r.status))}.`;
      }
      if (r.past_usda_date) return `The ${r.item} is past its USDA FoodKeeper date, so please toss it instead.`;
      if (r.winner) return `Sorry, ${r.winner} already claimed the ${r.item}.`;
      if (r.which_one) return `Which one: ${(r.which_one as string[]).join(" or ")}?`;
      return "Which item do you want to claim?";
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
      // Things someone says they got are groceries, so raw.
      return describeToolResult("add_item", runTool("add_item", { items: intent.items.map((name) => ({ name, state: "raw" })) }, ctx));
    case "use":
      return describeToolResult("use_item", runTool("use_item", { item: intent.item }, ctx));
    case "toss":
      return describeToolResult("log_toss", runTool("log_toss", { item: intent.item }, ctx));
    case "inventory":
      return describeToolResult("get_inventory", runTool("get_inventory", {}, ctx));
    case "claim":
      return describeToolResult("claim_item", runTool("claim_item", intent.item ? { item: intent.item } : {}, ctx));
  }
}
