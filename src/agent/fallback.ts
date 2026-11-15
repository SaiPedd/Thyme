// Rule-based fallback (LLM=off, no key, timeout, or failure). Handles the core patterns:
// "got X, Y", "used the X", "tossed X", "groceries $N split K ways", "undo", "what do I owe",
// "what's in the fridge", claims ("mine", "I'll take the X"), recipes, "I cooked it" + "yes",
// food preferences, "is the X still good?", and "forget me".
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
  | { kind: "claim"; item?: string }
  | { kind: "recipe"; another?: boolean }
  | { kind: "cooked" }
  | { kind: "confirm" }
  | { kind: "pref"; pref: "diet" | "dislike" | "allergy" | "like"; value: string }
  | { kind: "my_prefs" }
  | { kind: "forget" }
  | { kind: "check"; item: string }
  | { kind: "waste" };

const WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };

/** Words that follow "got" but aren't food ("got it", "got home"). */
const NOT_FOOD = new Set(["it", "this", "that", "them", "you", "home", "back", "here", "there", "paid", "time", "one", "nothing", "everything", "him", "her", "people", "mondays"]);

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
  if (/\b(how much (food )?(have|did) (we|i) (waste|wasted|toss|tossed|throw)|waste (report|summary|stats)|how much (food )?waste)/.test(t)) return { kind: "waste" };
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

  if (/^forget (me|about me|my (data|info|preferences|prefs))\b/.test(t)) return { kind: "forget" };
  if (/^(yes|yep|yeah|yup|y|confirm|do it|sure)[\s!.]*$/.test(t)) return { kind: "confirm" };
  if (/^(i |we )?(cooked|made) (it|that|this|the recipe)\b|^(done cooking|just cooked it)\b/.test(t)) return { kind: "cooked" };
  if (/\b(something else|another (one|recipe|idea)|anything else|other ideas?)\b/.test(t)) return { kind: "recipe", another: true };
  if (/\bwhat (can|should|could) (i|we) (make|cook|eat)\b|\brecipes?\b|\b(ideas?|plans?) for (dinner|lunch|breakfast)\b|\bwhat'?s for (dinner|lunch|breakfast)\b|\bi'?m (so )?hungry\b/.test(t)) {
    return { kind: "recipe" };
  }
  if (/\bmy (food )?(preferences|prefs|allergies|diet)\b|what do you know about me/.test(t)) return { kind: "my_prefs" };
  let p = t.match(/^(?:i'?m|i am)\s+(?:a\s+|now\s+)?(vegetarian|vegan|pescatarian|gluten[- ]free|dairy[- ]free|lactose intolerant|celiac|kosher|halal|keto)\b/);
  if (p) return { kind: "pref", pref: "diet", value: p[1]!.replace("lactose intolerant", "dairy-free").replace("celiac", "gluten-free") };
  if (/^i (don'?t|do not) eat meat\b/.test(t)) return { kind: "pref", pref: "diet", value: "vegetarian" };
  p = t.match(/^(?:i'?m |i am )?(?:allergic to|i have an? allergy to)\s+(.+)|^i have an? (.+?) allergy\b/);
  if (p) return { kind: "pref", pref: "allergy", value: cleanItem(p[1] ?? p[2]!) };
  p = t.match(/^i (?:don'?t|do not) (?:like|eat|want)\s+(.+)|^i (?:hate|can'?t stand)\s+(.+)|^no (.+?) for me\b/);
  if (p) {
    const v = cleanItem(p[1] ?? p[2] ?? p[3]!);
    if (!NOT_FOOD.has(v)) return { kind: "pref", pref: "dislike", value: v };
  }
  p = t.match(/^i (?:love|really like)\s+(.+)/);
  if (p && !NOT_FOOD.has(cleanItem(p[1]!))) return { kind: "pref", pref: "like", value: cleanItem(p[1]!) };
  p = t.match(/^(?:is|are) (?:the |my |our |this |that )?(.+?) (?:still )?(?:good|ok|okay|safe|fine)(?: to eat)?\b|^how long (?:does|do|will|can) (?:the |my |our )?(.+?) (?:last|keep|stay good)\b|^(?:has|have) (?:the |my )?(.+?) gone bad\b/);
  if (p) return { kind: "check", item: cleanItem(p[1] ?? p[2] ?? p[3]!) };

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
      if (!r.undone) return "There's nothing of yours to undo.";
      return r.kind === "toss" ? `Undone: the ${r.item} is back in the fridge list.` : `Undone: the ${r.total} expense is removed.`;
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
    case "log_toss": {
      if (!r.done) return `I don't see that in the fridge list.`;
      if (r.sent_privately) return "Logged. I DM'd you the details.";
      const owes = (r.who_owes_whom as string[] | undefined) ?? [];
      return [
        `Logged the ${r.item} as tossed${r.cost !== "unknown" ? ` (${r.cost})` : ""}.`,
        ...owes,
        ...(r.note ? [String(r.note)] : []),
        `Reply "undo" if that was a mistake.`,
      ].join("\n");
    }
    case "get_waste_summary": {
      type T = { items: number; dollars: string; weight: string; climate: string };
      const line = (label: string, x: { tossed: T; rescued: T }) =>
        `${label}: tossed ${x.tossed.items} (${x.tossed.dollars}, about ${x.tossed.weight}, ${x.tossed.climate}); rescued ${x.rescued.items} (${x.rescued.dollars}, about ${x.rescued.weight}).`;
      return [
        line("This month, the house", r.household_this_month),
        ...(r.you_this_month ? [line("You this month", r.you_this_month)] : []),
        "Pounds and CO2 are estimates by food type.",
      ].join("\n");
    }
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
    case "suggest_recipe": {
      if (!r.ok) {
        const avail = (r.available as string[] | undefined) ?? [];
        return avail.length
          ? `I don't have a simple recipe that fits what's here (${avail.join(", ")}). Tell me what you're in the mood for?`
          : "Nothing's logged in the kitchen yet. Tell me what you bought, like \"got spinach and eggs\".";
      }
      const expiring = (r.uses_food_expiring_soon as string[]) ?? [];
      const allergy = ((r.notes as string[]) ?? []).some((n) => n.startsWith("Saved allergies"));
      return [
        `Try ${String(r.title).toLowerCase()}: ${(r.ingredients as string[]).join(", ")}.`,
        ...(expiring.length ? [`It uses up the ${list(expiring)} before ${expiring.length === 1 && !isPlural(expiring[0]!) ? "it goes" : "they go"} bad.`] : []),
        ...(r.steps as string[]).map((st, i) => `${i + 1}. ${st}`),
        ...(allergy ? ["I avoided saved allergies by name, but I can't promise any dish is allergy-safe. Check every label."] : []),
        `Say "something else" for another idea, or "I made it" when you're done.`,
      ].join("\n");
    }
    case "cooked_recipe":
      if (r.needs_confirmation) return `Nice! Should I mark the ${list(r.would_mark_used as string[])} as used? Reply "yes".`;
      if (r.done) {
        const rescued = (r.rescued as string[]) ?? [];
        return `Done: marked the ${list(r.marked_used as string[])} as used.${rescued.length ? ` You rescued the ${list(rescued)}!` : ""}`;
      }
      return r.note === "Nothing is waiting for confirmation." ? null : "Which recipe? Tell me what you used, like \"used the spinach\".";
    case "save_preference":
      if (r.removed !== undefined) return r.removed ? "Okay, I've removed that." : "I didn't have that saved.";
      if (!r.saved) return "I didn't catch that preference.";
      if (r.value === undefined) return "Got it, I'll remember that for recipe ideas.";
      return r.kind === "allergy"
        ? `Got it: I'll keep ${r.value} out of recipe ideas for you. I can't promise anything is allergy-safe, so always check labels.`
        : r.kind === "diet"
          ? `Got it: ${r.value} recipes for you from now on.`
          : r.kind === "dislike"
            ? `Got it: no ${r.value} in your recipe ideas.`
            : `Noted: you like ${r.value}.`;
    case "get_preferences":
      if (r.sent_privately) return "I DM'd you what I have saved.";
      return (r.preferences as string[]).length ? ["Here's what I have saved for you:", ...(r.preferences as string[])].join("\n") : "You haven't saved any food preferences yet.";
    case "forget_me":
      return `Done. I deleted your saved preferences and our chat history. Expenses and balances stay so everyone's totals are right.`;
    case "check_item":
      if (r.item) return `The ${r.item}: ${r.status}. ${r.advice}`;
      return describeToolResult("shelf_life_lookup", r);
    default:
      return null;
  }
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

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
    case "recipe":
      return describeToolResult("suggest_recipe", runTool("suggest_recipe", intent.another ? { another: true } : {}, ctx));
    case "cooked":
      return describeToolResult("cooked_recipe", runTool("cooked_recipe", {}, ctx));
    case "confirm":
      return describeToolResult("cooked_recipe", runTool("cooked_recipe", { confirm: true }, ctx));
    case "pref":
      return describeToolResult("save_preference", runTool("save_preference", { kind: intent.pref, value: intent.value }, ctx));
    case "my_prefs":
      return describeToolResult("get_preferences", runTool("get_preferences", {}, ctx));
    case "forget":
      return describeToolResult("forget_me", runTool("forget_me", {}, ctx));
    case "check":
      return describeToolResult("check_item", runTool("check_item", { item: intent.item }, ctx));
    case "waste":
      return describeToolResult("get_waste_summary", runTool("get_waste_summary", {}, ctx));
  }
}
