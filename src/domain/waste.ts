// The waste ledger: tosses and rescues. A shared toss is split equally into the same balance table as
// grocery expenses (each non-buyer owes the buyer their share), unless the buyer already logged an
// expense that day, in which case the groceries were already split and charging again would double-count.

import type { Database } from "bun:sqlite";
import { now } from "../clock";
import { localDate } from "./expenses";
import { impactFor, type Impact } from "./impact";
import { setItemStatus, type Item } from "./inventory";
import { computeSplit, debtsFromShares } from "./splits";

export interface TossResult {
  ledgerId: number;
  costCents: number;
  shared: boolean;
  /** Who owes the buyer what for this toss; null when no balance changed. */
  debts: { debtorId: number; creditorId: number; amountCents: number }[] | null;
  splitSkippedReason?: "already_split" | "no_price" | "no_buyer" | "own_item";
}

/** True when the buyer logged an active expense on the local day the item was added. */
export function alreadySplit(db: Database, item: Item, tz: string): boolean {
  if (item.buyer_member_id === null) return false;
  const day = localDate(tz, new Date(item.added_at));
  return db
    .query<{ created_at: string }, [number, number]>(
      "SELECT created_at FROM expenses WHERE household_id = ? AND buyer_member_id = ? AND undone_at IS NULL",
    )
    .all(item.household_id, item.buyer_member_id)
    .some((e) => localDate(tz, new Date(e.created_at)) === day);
}

export function logToss(db: Database, item: Item, actorId: number, tz: string): TossResult {
  const at = now().toISOString();
  const cost = item.cost_cents ?? 0;
  const shared = item.owner_member_id === null;
  const buyer = item.buyer_member_id;

  let debts: TossResult["debts"] = null;
  let reason: TossResult["splitSkippedReason"];
  if (cost <= 0) reason = "no_price";
  else if (buyer === null) reason = "no_buyer";
  else if (alreadySplit(db, item, tz)) reason = "already_split";
  else if (shared) {
    const memberIds = db.query<{ id: number }, [number]>("SELECT id FROM members WHERE household_id = ? ORDER BY id").all(item.household_id).map((m) => m.id);
    if (!memberIds.includes(buyer)) memberIds.push(buyer);
    debts = debtsFromShares(computeSplit({ totalCents: cost, buyerId: buyer, memberIds }).shares, buyer);
  } else if (item.owner_member_id !== buyer) {
    // Someone else bought the owner's personal item: the owner owes it in full.
    debts = [{ debtorId: item.owner_member_id!, creditorId: buyer, amountCents: cost }];
  } else reason = "own_item";

  const ledgerId = db.transaction(() => {
    setItemStatus(db, item.id, "tossed");
    const row = db
      .query<{ id: number }, [number, number, number, number, number, number | null, string]>(
        `INSERT INTO ledger (household_id, item_id, member_id, kind, cost_cents, shared, buyer_member_id, at)
         VALUES (?, ?, ?, 'wasted', ?, ?, ?, ?) RETURNING id`,
      )
      .get(item.household_id, item.id, actorId, cost, shared ? 1 : 0, buyer, at)!;
    for (const d of debts ?? []) {
      db.run(
        `INSERT INTO balance_entries (household_id, debtor_member_id, creditor_member_id, amount_cents, source, source_id, created_at)
         VALUES (?, ?, ?, ?, 'waste', ?, ?)`,
        [item.household_id, d.debtorId, d.creditorId, d.amountCents, row.id, at],
      );
    }
    return row.id;
  })();

  if (debts && debts.length === 0) debts = null;
  return { ledgerId, costCents: cost, shared, debts, ...(reason ? { splitSkippedReason: reason } : {}) };
}

/** Record that an at-risk item was eaten in time. The caller marks it used. */
export function logRescue(db: Database, item: Item, actorId: number): void {
  db.run(
    `INSERT INTO ledger (household_id, item_id, member_id, kind, cost_cents, shared, buyer_member_id, at)
     VALUES (?, ?, ?, 'rescued', ?, ?, ?, ?)`,
    [item.household_id, item.id, actorId, item.cost_cents ?? 0, item.owner_member_id === null ? 1 : 0, item.buyer_member_id, now().toISOString()],
  );
}

/** The member's most recent toss that can still be undone (item still tossed). */
export function lastToss(db: Database, householdId: number, memberId: number): { ledgerId: number; itemId: number; name: string; at: string } | null {
  return db
    .query<{ ledgerId: number; itemId: number; name: string; at: string }, [number, number]>(
      `SELECT l.id AS ledgerId, l.item_id AS itemId, i.name AS name, l.at AS at FROM ledger l JOIN items i ON i.id = l.item_id
        WHERE l.household_id = ? AND l.member_id = ? AND l.kind = 'wasted' AND i.status = 'tossed'
        ORDER BY l.id DESC LIMIT 1`,
    )
    .get(householdId, memberId);
}

/** Undo the member's last toss: the item is back in the fridge, and its waste balances are removed. */
export function undoLastToss(db: Database, householdId: number, memberId: number): { name: string } | null {
  const last = lastToss(db, householdId, memberId);
  if (!last) return null;
  const at = now().toISOString();
  db.transaction(() => {
    db.run("UPDATE items SET status = 'fresh', status_at = ? WHERE id = ?", [at, last.itemId]);
    db.run("UPDATE balance_entries SET undone_at = ? WHERE source = 'waste' AND source_id = ? AND undone_at IS NULL", [at, last.ledgerId]);
    db.run("DELETE FROM ledger WHERE id = ?", [last.ledgerId]);
  })();
  return { name: last.name };
}

export interface KindTotals extends Impact {
  count: number;
  cents: number;
}

export interface WasteTotals {
  wasted: KindTotals;
  rescued: KindTotals;
}

/** Household (or one member's own) tosses and rescues, optionally since a time. */
export function wasteTotals(db: Database, householdId: number, opts: { memberId?: number; sinceIso?: string } = {}): WasteTotals {
  const rows = db
    .query<{ kind: "wasted" | "rescued"; cost_cents: number; category: string | null }, [number, number, number, string]>(
      `SELECT l.kind, l.cost_cents, s.category FROM ledger l
         LEFT JOIN items i ON i.id = l.item_id
         LEFT JOIN shelf_life s ON s.id = i.shelf_life_id
        WHERE l.household_id = ? AND (? = 0 OR l.member_id = ?) AND l.at >= ?`,
    )
    .all(householdId, opts.memberId ?? 0, opts.memberId ?? 0, opts.sinceIso ?? "");
  const zero = (): KindTotals => ({ count: 0, cents: 0, grams: 0, co2Grams: 0 });
  const out: WasteTotals = { wasted: zero(), rescued: zero() };
  for (const r of rows) {
    const t = out[r.kind];
    const imp = impactFor(r.category);
    t.count++;
    t.cents += r.cost_cents;
    t.grams += imp.grams;
    t.co2Grams += imp.co2Grams;
  }
  return out;
}

/** Start of the current month in the household time zone, as an ISO string (approximate to the day). */
export function monthStartIso(tz: string, at: Date = now()): string {
  const [y, m] = localDate(tz, at).split("-");
  // Local midnight on the 1st; the offset is taken from that date so DST is handled.
  const guess = new Date(`${y}-${m}-01T00:00:00Z`);
  const local = new Date(guess.toLocaleString("en-US", { timeZone: tz }));
  return new Date(guess.getTime() + (guess.getTime() - local.getTime())).toISOString();
}
