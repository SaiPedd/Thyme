// The receipt conversation: show what was read, let people say who paid and whose items are whose,
// and only save after a "yes". The reply is parsed in code, so it works with the LLM off too.
//
//   photo           -> "Got your receipt: 1. spinach $3.99 ... Reply yes to save, or tell me changes"
//   "Sam paid"      -> buyer is Sam (also works as a caption on the photo)
//   "2 is mine"     -> item 2 is the sender's; "3 and 4 are Jordan's"; "5 is me and Sam's"; "2 is shared" undoes it
//   "split with Sam only" / "split between me and Jordan" / "just me and Sam" -> who shares the rest
//   "total is $X"   -> use a corrected total when the numbers don't add up
//   "4 was bananas" -> names a blurry line whose price was worked out from the total ("it was bananas" works too)
//   "yes"           -> record the expense (source receipt) and add the food to the fridge
//   "cancel"        -> drop it

import type { Database } from "bun:sqlite";
import { now } from "../clock";
import { DuplicateExpenseError, recordExpense } from "../domain/expenses";
import { memberByName, type Member } from "../domain/household";
import { addItem } from "../domain/inventory";
import { formatCents, parseCents } from "../domain/money";
import type { Draft } from "../privacy/projection";
import { allocate, lookupPhrase, type CheckedReceipt, type ReceiptLine } from "./receipt";

export const RECEIPT_TTL_MS = 60 * 60 * 1000;

/** Lines that belong in the bill but not in the fridge. */
const NOT_FOOD = /\b(bag|bags|fee|deposit|crv|tip|donation|gift|coupon|service|paper towels?|paper plates?|plates?|utensils?|forks?|straws?|toilet paper|detergent|soap|shampoo|toothpaste|batter(y|ies)|foil|napkins?|sponges?|trash)\b/i;

export interface PendingReceipt {
  store: string | null;
  items: ReceiptLine[];
  taxCents: number;
  discountCents: number;
  totalCents: number;
  balanced: boolean;
  diffCents: number;
  unreadable: number;
  buyerId: number;
  senderId: number;
  /** Who shares everything not assigned to specific people; null = the whole household. */
  splitAmong: number[] | null;
  at: string;
}

const key = (memberId: number) => `receipt:${memberId}`;

export function getPendingReceipt(db: Database, memberId: number): PendingReceipt | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key(memberId));
  if (!row) return null;
  const p = JSON.parse(row.value) as PendingReceipt;
  if (Date.parse(p.at) + RECEIPT_TTL_MS < now().getTime()) {
    clearPendingReceipt(db, memberId);
    return null;
  }
  return p;
}

/** Saves only items, amounts, and member ids: never the image, its URL, or payment details. */
export function savePendingReceipt(db: Database, p: PendingReceipt): void {
  db.run("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key(p.senderId), JSON.stringify(p)]);
}

export function clearPendingReceipt(db: Database, memberId: number): void {
  db.run("DELETE FROM state WHERE key = ?", [key(memberId)]);
}

export function pendingFromCheck(r: CheckedReceipt, senderId: number, buyerId = senderId): PendingReceipt {
  return {
    store: r.store,
    items: r.items,
    taxCents: r.taxCents,
    discountCents: r.discountCents,
    totalCents: r.totalCents,
    balanced: r.balanced,
    diffCents: r.diffCents,
    unreadable: r.unreadable,
    buyerId,
    senderId,
    splitAmong: null,
    at: now().toISOString(),
  };
}

// ---- Parsing replies ----

export interface ReceiptReply {
  confirm: boolean;
  cancel: boolean;
  /** "second trip" / "again": the user says it isn't a duplicate. */
  notDuplicate: boolean;
  buyerId?: number;
  assign: { index: number; owners: number[] | null }[];
  /** Who shares the rest: a list, null for everyone, undefined for no change. */
  splitAmong?: number[] | null;
  totalCents?: number;
  error?: string;
}

const NUM = String.raw`\d{1,2}`;
const NUM_LIST = String.raw`(?:#?${NUM}(?:\s*(?:,|and|&|\+)\s*#?${NUM})*)`;

function resolve(members: Member[], senderId: number, who: string): number | null {
  const w = who.trim().toLowerCase().replace(/'s$/, "");
  if (["i", "me", "mine", "my", "myself"].includes(w)) return senderId;
  return memberByName(members, w)?.id ?? null;
}

/** A name, not followed by "paid"/"bought" (that's the buyer, not an owner). */
const NAME = String.raw`(?!(?:split|total|yes|ok|okay|cancel|and|is|are|paid|bought|only|just)\b)[a-z]+(?:'s)?\b(?!\s+(?:paid|bought))`;
const NAMES = String.raw`${NAME}(?:\s*(?:,|&|\band\b)\s*${NAME})*`;
const EVERYONE = /^(shared|everyone'?s?|for everyone|all of us|the (whole )?house(hold)?|everybody)$/i;

/** "me and Sam's" -> [sender, Sam]; null if anyone is unknown (with their name). */
function resolveList(members: Member[], senderId: number, list: string): { ids: number[] } | { unknown: string } {
  const ids: number[] = [];
  for (const part of list.split(/\s*(?:,|&|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean)) {
    const id = resolve(members, senderId, part);
    if (id === null) return { unknown: part.replace(/'s$/i, "") };
    ids.push(id);
  }
  return { ids: [...new Set(ids)] };
}

const unknownWho = (members: Member[], who: string) => `I don't know who "${who}" is. Roommates: ${members.map((m) => m.name).join(", ")}`;

/** Parse a reply to a pending receipt. Null when the message isn't about the receipt. */
export function parseReceiptReply(raw: string, members: Member[], senderId: number): ReceiptReply | null {
  const text = raw.trim().replace(/[.!]+$/, "");
  const t = text.toLowerCase();
  const out: ReceiptReply = { confirm: false, cancel: false, notDuplicate: false, assign: [] };
  let matched = false;

  if (/^(cancel|no|nope|nevermind|never mind|discard|drop it|forget it|scrap that)\b/.test(t)) return { ...out, cancel: true };
  if (/^(yes|yep|yeah|yup|y|ok|okay|confirm|looks good|looks right|correct|save( it)?|sure|perfect|lgtm)\b/.test(t)) {
    out.confirm = true;
    matched = true;
  }
  if (/\b(second (trip|purchase|time)|again|another (trip|one)|not a duplicate)\b/.test(t)) {
    out.notDuplicate = true;
    matched = true;
  }

  const buyer = text.match(/\b(?:paid by|bought by)\s+([a-z]+)/i) ?? text.match(/\b([a-z]+)\s+(?:paid|bought (?:it|this|these|them|the groceries|everything))\b/i);
  if (buyer) {
    const id = resolve(members, senderId, buyer[1]!);
    if (id === null) return { ...out, error: `I don't know who "${buyer[1]}" is. Roommates: ${members.map((m) => m.name).join(", ")}` };
    out.buyerId = id;
    matched = true;
  }

  // Item owners: "2 is mine", "3 and 4 are Sam's", "5 is me and Jordan's", "2 is shared",
  // "1 is shared between me and Jordan" (exactly them), "1 is shared with Sam" (sender + Sam).
  const assignRe = new RegExp(
    String.raw`(?:items?\s+)?(${NUM_LIST})\s+(?:is|are|was|were|=|goes to|go to|for)\s+(?:just\s+|only\s+|all\s+)?(?:(?:shared|split)\s+(between|with|among|amongst|by)\s+(?:just\s+|only\s+)?)?(shared|everyone'?s?|for everyone|(?:for\s+)?${NAMES})`,
    "gi",
  );
  let rest = text; // the message minus item assignments, so "1 is split between me and Sam" doesn't re-split the rest
  for (const m of text.matchAll(assignRe)) {
    rest = rest.replace(m[0], " ");
    const who = m[3]!.replace(/^for\s+/i, "");
    let owners: number[] | null = null;
    if (!EVERYONE.test(m[3]!)) {
      const r = resolveList(members, senderId, who);
      if ("unknown" in r) return { ...out, error: unknownWho(members, r.unknown) };
      owners = m[2]?.toLowerCase() === "with" ? [...new Set([senderId, ...r.ids])] : r.ids;
    }
    for (const n of m[1]!.match(/\d+/g) ?? []) out.assign.push({ index: Number(n), owners });
    matched = true;
  }

  // Who shares the rest: "split with Sam only" (sender + Sam), "split between Sam and Jordan" (exactly them),
  // "just me and Sam", "split evenly" / "split with everyone" (back to the whole house).
  if (/\bsplit\s+(?:it\s+)?(?:evenly|equally|with everyone|between everyone|among everyone)\b/i.test(rest)) {
    out.splitAmong = null;
    matched = true;
  } else {
    const splitWith = rest.match(new RegExp(String.raw`\bsplit\s+(?:it\s+|this\s+|the rest\s+)?(with|between|among|amongst)\s+(?:just\s+|only\s+)?(${NAMES})`, "i"));
    const justUs = rest.match(new RegExp(String.raw`(?:^|[,\s])(?:just|only)\s+(me\s+and\s+${NAMES}|${NAME}\s+and\s+me)\b`, "i"));
    // "with Sam" includes the sender; "between Sam and Jordan" and "just me and Sam" are exactly those people.
    const includeSender = splitWith?.[1]!.toLowerCase() === "with";
    const names = splitWith?.[2] ?? justUs?.[1];
    if (names) {
      const r = resolveList(members, senderId, names);
      if ("unknown" in r) return { ...out, error: unknownWho(members, r.unknown) };
      out.splitAmong = [...new Set(includeSender ? [senderId, ...r.ids] : r.ids)];
      matched = true;
    }
  }

  const total = t.match(/\btotal\s+(?:is|was|=|should be)?\s*(\$?\s?\d[\d,]*(?:\.\d{1,2})?)/);
  if (total) {
    const cents = parseCents(total[1]!);
    if (cents) {
      out.totalCents = cents;
      matched = true;
    }
  }
  return matched ? out : null;
}

// ---- Wording ----

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export function receiptSummary(p: PendingReceipt, members: Member[]): string {
  const name = (id: number) => members.find((m) => m.id === id)?.name ?? "someone";
  const lines = [`Got ${p.store ? `the ${p.store}` : "your"} receipt:`];
  const who = (ids: number[]) => (ids.length === 1 ? `just ${name(ids[0]!)}'s` : list(ids.map(name)));
  const note = (it: ReceiptLine) => (it.couponCents ? ` (after ${formatCents(it.couponCents)} coupon)` : "") + (it.inferred ? (it.named ? " (price was blurry, worked out from the total)" : " (blurry, worked out from the total)") : it.unclear ? ` (${it.unclear} lines I couldn't read)` : "");
  p.items.forEach((it, i) => lines.push(`${i + 1}. ${it.name} ${formatCents(it.cents)}${it.owners?.length ? ` (${who(it.owners)})` : ""}${note(it)}`));
  const extras = [
    ...(p.discountCents ? [`savings -${formatCents(p.discountCents)}`] : []),
    ...(p.taxCents ? [`tax ${formatCents(p.taxCents)}`] : []),
    `total ${formatCents(p.totalCents)}`,
  ];
  lines.push(extras.join(", ") + ".");
  if (!p.balanced) {
    const computed = p.totalCents + p.diffCents;
    lines.push(`Heads up: the lines add up to ${formatCents(computed)}, but the total says ${formatCents(p.totalCents)}. Reply "total is $X" to fix it, or "yes" to use ${formatCents(p.totalCents)}.`);
  }
  if (p.unreadable) {
    lines.push(`I couldn't read ${p.unreadable} line${p.unreadable === 1 ? "" : "s"}. Is anything missing? You can say "total is $X", or send a clearer photo.`);
  }
  // Only ask when we couldn't read what the line was; a blurry price alone is already worked out.
  const inferred = p.items.findIndex((it) => (it.inferred && !it.named) || it.unnamed);
  if (inferred >= 0) lines.push(`I couldn't read line ${inferred + 1}. What was it? Reply like "${inferred + 1} was yogurt".`);
  const unclear = p.items.find((it) => it.unclear);
  if (unclear) lines.push(`I couldn't read ${unclear.unclear} lines, so they're counted as shared "other groceries" unless you tell me what they were.`);
  const assigned = p.items.some((it) => it.owners?.length);
  const among = p.splitAmong ? `split between ${list(p.splitAmong.map(name))}` : "split evenly with everyone";
  lines.push(`Paid by ${name(p.buyerId)}. ${assigned ? `The rest is ${among}` : `Everything is ${among}`}${p.splitAmong ? "." : " unless you say otherwise."}`);
  lines.push(`Reply "yes" to save, or tell me changes like "Sam paid", "2 is mine", or "split with Sam only". "cancel" to drop it.`);
  return lines.join("\n");
}

// ---- Applying a reply ----

export interface ReceiptContext {
  db: Database;
  householdId: number;
  tz: string;
  members: Member[];
  member: Member;
  messageId?: string;
  isGroup?: boolean;
  /** Extra messages to send after the reply (e.g. the split to the group when confirmed in a DM). */
  drafts?: Draft[];
}

/**
 * "4 was bananas" / "it was bananas": names a blurry line. Only for lines we filled in from the total,
 * and only when the words aren't a roommate ("4 is Sam's" stays an owner change).
 */
function renameBlurry(p: PendingReceipt, text: string, members: Member[], senderId: number): number | null {
  const t = text.trim().replace(/[.!]+$/, "").toLowerCase();
  const m = /^(?:(?:item|line)\s*|#)?(\d{1,2})\s+(?:is|was)\s+(?:a |an |the )?(.+)$/.exec(t) ?? /^(?:it|that|the blurry one|the missing one)\s+(?:is|was)\s+(?:a |an |the )?(.+)$/.exec(t);
  if (!m) return null;
  const index = m.length === 3 && /^\d/.test(m[1]!) ? Number(m[1]) - 1 : p.items.findIndex((it) => it.inferred || it.unclear || it.unnamed);
  const name = (m.length === 3 && /^\d/.test(m[1]!) ? m[2] : m[1])!.trim();
  const line = p.items[index];
  if (!line || !(line.inferred || line.unclear || line.unnamed)) return null;
  if (/^\$?[\d.,\s]+$/.test(name)) return null; // a price, not a name
  if (/^(mine|shared|everyone'?s?|for everyone)$/.test(name) || resolve(members, senderId, name.split(/\s+/)[0]!) !== null) return null;
  line.name = name.slice(0, 60);
  line.inferred = false;
  line.unclear = undefined;
  line.unnamed = false;
  line.named = true;
  return index;
}

/**
 * "3 was 6.49" / "3 is $6.49" / "item 3 costs 6" / "3 was free": corrects one line's price (even to $0), then re-checks the sum
 * against the printed total.
 */
function setPrice(p: PendingReceipt, text: string): number | null {
  const t = text.trim().replace(/[.!]+$/, "").toLowerCase();
  const m = /^(?:(?:item|line)\s*|#)?(\d{1,2})\s+(?:is|was|=|costs?|cost|should be|is actually|was actually)\s+(\$?\s?\d[\d,]*(?:\.\d{1,2})?|free|nothing|zero)$/.exec(t);
  if (!m) return null;
  const index = Number(m[1]) - 1;
  const line = p.items[index];
  // $0 is a real price (a free item, or a line that was misread): only "couldn't read it" is null.
  const cents = /^(free|nothing|zero)$/.test(m[2]!) ? 0 : parseCents(m[2]!);
  if (!line || cents === null) return null;
  line.cents = cents;
  line.inferred = false;
  const itemsCents = p.items.reduce((s, i) => s + i.cents, 0);
  p.diffCents = itemsCents - p.discountCents + p.taxCents - p.totalCents;
  p.balanced = p.totalCents > 0 && Math.abs(p.diffCents) <= 1;
  return index;
}

/**
 * "remove 3" / "delete line 3" / "take off 3 and 5" / "3 isn't on the receipt": drops misread lines
 * before saving. Returns the removed names, or null if the message isn't a removal.
 */
function removeLines(p: PendingReceipt, text: string): { removed: string[] } | { error: string } | null {
  const t = text.trim().replace(/[.!]+$/, "").toLowerCase();
  const list = String.raw`(?:items?|lines?|#)?\s*(\d{1,2}(?:\s*(?:,|and|&|\+)\s*#?\d{1,2})*)`;
  const m =
    new RegExp(String.raw`^(?:remove|delete|drop|cross off|cross out|take off|take out|get rid of|scratch)\s+${list}(?:\s+(?:from|off)\s+(?:the\s+)?(?:list|receipt))?$`).exec(t) ??
    new RegExp(String.raw`^${list}\s+(?:isn'?t|wasn'?t|is not|was not)\s+(?:on\s+(?:the|my|it|this)|(?:a\s+)?real|mine to (?:pay|split)|there)(?:\s+(?:receipt|list))?$`).exec(t);
  if (!m) return null;
  const nums = [...new Set((m[1]!.match(/\d+/g) ?? []).map(Number))];
  const bad = nums.filter((n) => n < 1 || n > p.items.length);
  if (bad.length) return { error: `The receipt only has items 1 to ${p.items.length}. Which did you mean?` };
  if (nums.length >= p.items.length) return { error: `That would remove every item. Reply "cancel" to drop the whole receipt.` };
  const removed = nums.map((n) => p.items[n - 1]!.name);
  p.items = p.items.filter((_, i) => !nums.includes(i + 1));
  const itemsCents = p.items.reduce((s, i) => s + i.cents, 0);
  p.diffCents = itemsCents - p.discountCents + p.taxCents - p.totalCents;
  p.balanced = p.totalCents > 0 && Math.abs(p.diffCents) <= 1;
  return { removed };
}

/** Handle a reply to the sender's pending receipt. Returns the reply text, or null if not about the receipt. */
export function handleReceiptReply(ctx: ReceiptContext, text: string): string | null {
  const p = getPendingReceipt(ctx.db, ctx.member.id);
  if (!p) return null;
  const removal = removeLines(p, text);
  if (removal && "error" in removal) return removal.error;
  if (removal) {
    p.at = now().toISOString();
    savePendingReceipt(ctx.db, p);
    return `Removed ${list(removal.removed)}.\n${receiptSummary(p, ctx.members)}`;
  }
  if (setPrice(p, text) !== null || renameBlurry(p, text, ctx.members, ctx.member.id) !== null) {
    p.at = now().toISOString();
    savePendingReceipt(ctx.db, p);
    return receiptSummary(p, ctx.members);
  }
  const r = parseReceiptReply(text, ctx.members, ctx.member.id);
  if (!r) return null;
  if (r.error) return r.error;
  if (r.cancel) {
    clearPendingReceipt(ctx.db, ctx.member.id);
    return "Okay, I dropped that receipt. Nothing was saved.";
  }

  const bad = r.assign.filter((a) => a.index < 1 || a.index > p.items.length).map((a) => a.index);
  if (bad.length) return `The receipt only has items 1 to ${p.items.length}. Which did you mean?`;
  for (const a of r.assign) p.items[a.index - 1]!.owners = a.owners;
  if (r.buyerId !== undefined) p.buyerId = r.buyerId;
  if (r.splitAmong !== undefined) p.splitAmong = r.splitAmong;
  if (r.totalCents !== undefined) {
    const computed = p.totalCents + p.diffCents;
    p.totalCents = r.totalCents;
    p.diffCents = computed - r.totalCents;
    p.balanced = true; // the user set the total
    p.unreadable = 0;
  }
  p.at = now().toISOString();
  savePendingReceipt(ctx.db, p);

  if (!r.confirm && !r.notDuplicate) return receiptSummary(p, ctx.members);
  return commitReceipt(ctx, p, r.notDuplicate);
}

function commitReceipt(ctx: ReceiptContext, p: PendingReceipt, allowDuplicate: boolean): string {
  const name = (id: number) => ctx.members.find((m) => m.id === id)?.name ?? "someone";
  if (p.totalCents <= 0) return `I couldn't read a total. Reply "total is $X" with the amount you paid.`;
  const allocations = allocate(p.items, p.totalCents);
  if (p.splitAmong) {
    // The rest goes only to the people sharing it (the buyer pays nothing if they're not among them).
    const rest = p.totalCents - allocations.reduce((s, a) => s + a.amountCents, 0);
    if (rest > 0) allocations.push({ amountCents: rest, memberIds: p.splitAmong });
  }
  const memberIds = [...new Set([p.buyerId, ...(p.splitAmong ?? ctx.members.map((m) => m.id)), ...allocations.flatMap((a) => a.memberIds)])];

  let expense;
  try {
    expense = recordExpense(ctx.db, {
      householdId: ctx.householdId,
      tz: ctx.tz,
      spec: { totalCents: p.totalCents, buyerId: p.buyerId, memberIds, allocations },
      loggedById: ctx.member.id,
      description: p.store ? `${p.store} receipt` : "receipt",
      source: "receipt",
      sourceMessageId: ctx.messageId,
      allowDuplicate,
    });
  } catch (error) {
    if (error instanceof DuplicateExpenseError) {
      return `${name(p.buyerId)} already logged ${formatCents(p.totalCents)} today. Is this a second trip? Reply "yes, second trip" to save it anyway, or "cancel".`;
    }
    return `I couldn't split that: ${(error as Error).message}. Try "total is $X" or "cancel".`;
  }
  clearPendingReceipt(ctx.db, ctx.member.id);

  let added = 0;
  const skipped: string[] = [];
  const unknown: string[] = []; // food we couldn't match to a USDA FoodKeeper entry, so no safe expiry date
  for (const it of p.items) {
    // Lumped or still-unnamed blurry lines are money only: we don't know what food they were.
    if (it.unclear || it.unnamed || (it.inferred && !it.named)) continue;
    if (NOT_FOOD.test(it.name)) {
      skipped.push(it.name);
      continue;
    }
    const r = addItem(ctx.db, {
      householdId: ctx.householdId,
      name: it.name,
      buyerId: p.buyerId,
      // One owner: theirs (reminders go to their DM). Several or none: shared in the fridge list.
      ownerId: it.owners?.length === 1 ? it.owners[0]! : null,
      state: "raw",
      priceCents: it.cents,
      costSource: "receipt",
      expenseId: expense.id,
      lookupName: lookupPhrase(it.name),
    });
    if (r.ok) added++;
    else unknown.push(it.name);
  }

  const payer = name(expense.buyerId);
  const owes = expense.shares
    .filter((s) => s.memberId !== expense.buyerId && s.cents > 0)
    .map((s) => `${name(s.memberId)} owes ${payer} ${formatCents(s.cents)}`);
  const payerShare = expense.shares.find((s) => s.memberId === expense.buyerId)?.cents ?? 0;
  // Confirmed in a DM: roommates still need to see what they owe (a shared split is household content).
  if (ctx.isGroup === false && ctx.drafts) {
    ctx.drafts.push({
      audience: { kind: "group" },
      sensitivity: "household",
      text: [`${name(ctx.member.id)} logged ${p.store ? `a ${p.store}` : "a"} receipt: ${formatCents(expense.totalCents)} paid by ${payer}.`, ...owes].join("\n"),
    });
  }
  return [
    `Saved: ${formatCents(expense.totalCents)} paid by ${payer}.`,
    ...owes,
    payerShare > 0 ? `${payer}'s own share is ${formatCents(payerShare)} (already paid).` : `${payer} isn't in on this one, so ${payer} is owed the full amount.`,
    added ? `Added ${added} item${added === 1 ? "" : "s"} to the fridge list with their receipt prices.` : "",
    skipped.length ? `Not added to the fridge (not food): ${skipped.join(", ")}.` : "",
    unknown.length ? `Not added to the fridge (I don't know how long ${unknown.length === 1 ? "it keeps" : "they keep"}): ${unknown.join(", ")}. Tell me what ${unknown.length === 1 ? "it is" : "they are"} to add ${unknown.length === 1 ? "it" : "them"}.` : "",
    `Reply "undo" to remove the expense.`,
  ]
    .filter(Boolean)
    .join("\n");
}
