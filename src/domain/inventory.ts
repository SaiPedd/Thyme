// The household's food: adding (with FoodKeeper expiry), finding by name, marking used or tossed,
// and wording how long something has left. Expiry is computed here from FoodKeeper, never by the model.

import type { Database } from "bun:sqlite";
import { now } from "../clock";
import { localDate } from "./expenses";
import { recordLedger } from "./ledger";
import { defaultStorage, expiryFor, getShelfLife, pickShelfLife, shelfLifeNote, type ShelfLifeRow, type Storage } from "./foodkeeper";

/** Items expiring within this window are "at risk": reminders, claims, and rescues. */
export const AT_RISK_MS = 48 * 60 * 60 * 1000;

export interface Item {
  id: number;
  household_id: number;
  name: string;
  shelf_life_id: number | null;
  storage: Storage;
  owner_member_id: number | null;
  buyer_member_id: number | null;
  cost_cents: number | null;
  cost_source: "receipt" | "user" | "estimate" | null;
  added_at: string;
  expires_at: string | null;
  status: "fresh" | "used" | "tossed";
}

export interface AddItemInput {
  householdId: number;
  name: string;
  buyerId: number;
  /** null = shared with the household. */
  ownerId: number | null;
  /** FoodKeeper id the model picked from shelf_life_lookup. */
  shelfLifeId?: number;
  storage?: Storage;
  state?: "raw" | "cooked";
  priceCents?: number | null;
}

export type AddItemResult =
  | { ok: true; item: Item; food: string; note: string | null }
  | { ok: false; reason: "no_match" }
  | { ok: false; reason: "ambiguous"; options: string[] };

const foodLabel = (r: ShelfLifeRow) => (r.subtitle ? `${r.name.trim()} (${r.subtitle})` : r.name.trim());

export function addItem(db: Database, input: AddItemInput): AddItemResult {
  let row = input.shelfLifeId !== undefined ? getShelfLife(db, input.shelfLifeId) : null;
  if (!row) {
    const pick = pickShelfLife(db, input.name, input.state);
    if (!pick) return { ok: false, reason: "no_match" };
    if ("ambiguous" in pick) return { ok: false, reason: "ambiguous", options: pick.ambiguous };
    row = pick.row;
  }
  const storage = input.storage ?? defaultStorage(row);
  const at = now();
  const expires = expiryFor(row, storage, at);
  // Prices come only from what a roommate said they paid (or, later, a receipt). Never estimated.
  const cost = input.priceCents ?? null;
  const item = db
    .query<Item, [number, string, number, string, number | null, number, number | null, string | null, string, string | null]>(
      `INSERT INTO items (household_id, name, shelf_life_id, storage, owner_member_id, buyer_member_id, qty, cost_cents, cost_source, added_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'fresh') RETURNING *`,
    )
    .get(
      input.householdId,
      input.name.trim(),
      row.id,
      storage,
      input.ownerId,
      input.buyerId,
      cost,
      cost === null ? null : "user",
      at.toISOString(),
      expires?.toISOString() ?? null,
    )!;
  return { ok: true, item, food: foodLabel(row), note: expires ? null : shelfLifeNote(row, storage) };
}

/** Set an item's price from what a roommate said they paid, or from a receipt. */
export function setItemPrice(db: Database, itemId: number, cents: number, source: "user" | "receipt"): void {
  db.run("UPDATE items SET cost_cents = ?, cost_source = ? WHERE id = ?", [cents, source, itemId]);
}

/** Whole local days from today until the expiry date (0 = today, negative = past). */
export function daysLeft(expiresAt: string, tz: string, at: Date = now()): number {
  return Math.round((Date.parse(localDate(tz, new Date(expiresAt))) - Date.parse(localDate(tz, at))) / 86_400_000);
}

export function isPast(item: Pick<Item, "expires_at">, at: Date = now()): boolean {
  return item.expires_at !== null && Date.parse(item.expires_at) <= at.getTime();
}

export function isAtRisk(item: Pick<Item, "expires_at">, at: Date = now()): boolean {
  return item.expires_at !== null && Date.parse(item.expires_at) <= at.getTime() + AT_RISK_MS;
}

/** "expires tomorrow", "expires in 4 days", "past its USDA date", or the USDA note when there's no number. */
export function expiryPhrase(item: Pick<Item, "expires_at">, tz: string, note: string | null = null, at: Date = now()): string {
  if (item.expires_at === null) return note ? `no USDA shelf life; ${note.toLowerCase()}` : "no USDA shelf life listed";
  if (isPast(item, at)) return "past its USDA date";
  const d = daysLeft(item.expires_at, tz, at);
  if (d <= 0) return "expires today";
  if (d === 1) return "expires tomorrow";
  return `expires in ${d} days`;
}

/** "bananas", "chicken thighs" read as plural (not "hummus", "swiss"). */
export function isPlural(name: string): boolean {
  return /[^su]s$/i.test(name.trim());
}

/** Make an expiry phrase agree with its subject: "the bananas expire tomorrow". */
export function agree(name: string, phrase: string): string {
  return isPlural(name) ? phrase.replace(/^expires\b/, "expire") : phrase;
}

/** The USDA note for an item's storage, for items without a computed date. */
export function itemNote(db: Database, item: Item): string | null {
  if (item.expires_at !== null || item.shelf_life_id === null) return null;
  const row = getShelfLife(db, item.shelf_life_id);
  return row ? shelfLifeNote(row, item.storage) : null;
}

/** Fresh items a member can see: shared ones plus their own (or shared only). Soonest expiry first. */
export function visibleItems(db: Database, householdId: number, memberId: number, opts: { sharedOnly?: boolean } = {}): Item[] {
  return db
    .query<Item, [number, number]>(
      `SELECT * FROM items WHERE household_id = ? AND status = 'fresh'
         AND (owner_member_id IS NULL OR owner_member_id = ?)
       ORDER BY expires_at IS NULL, expires_at, added_at`,
    )
    .all(householdId, opts.sharedOnly ? -1 : memberId);
}

const STOP = new Set(["the", "a", "an", "some", "my", "our", "of", "last", "rest", "that", "those", "these", "this"]);

function singular(w: string): string {
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ch|sh|x|o)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function nameWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map(singular);
}

/** Best match for "the spinach" among the given items; null if nothing shares a word. Ties go to the soonest expiry. */
export function matchItem<T extends Pick<Item, "name">>(items: T[], phrase: string): T | null {
  const q = nameWords(phrase);
  if (q.length === 0) return null;
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const w = nameWords(item.name);
    const overlap = q.filter((x) => w.includes(x)).length;
    if (overlap === 0) continue;
    const score =
      overlap === q.length && overlap === w.length ? 3 : overlap === q.length ? 2 : overlap === w.length ? 1.5 : overlap / Math.max(q.length, w.length);
    if (!best || score > best.score) best = { item, score };
  }
  return best?.item ?? null;
}

export function findItem(db: Database, householdId: number, memberId: number, phrase: string, opts: { sharedOnly?: boolean } = {}): Item | null {
  return matchItem(visibleItems(db, householdId, memberId, opts), phrase);
}

/**
 * Mark an item used or tossed, close any open reminder for it, and write the waste ledger:
 * tossed = wasted; used while at risk (within 48h) and not past its date = rescued.
 * `by` is the member who did it.
 */
export function setItemStatus(db: Database, itemId: number, status: "used" | "tossed", by: number | null = null): void {
  const at = now().toISOString();
  db.transaction(() => {
    const item = db.query<Item, [number]>("SELECT * FROM items WHERE id = ? AND status = 'fresh'").get(itemId);
    if (item && status === "tossed") recordLedger(db, item, "wasted", by);
    else if (item && isAtRisk(item) && !isPast(item)) recordLedger(db, item, "rescued", by);
    db.run("UPDATE items SET status = ?, status_at = ? WHERE id = ?", [status, at, itemId]);
    db.run("UPDATE nudges SET responded_at = ? WHERE item_id = ? AND responded_at IS NULL", [at, itemId]);
  })();
}
