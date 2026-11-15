// Waste ledger: what the household tossed (wasted) and what it ate just before it expired (rescued).
// Tracking only: the ledger never changes balances, because a shared item's cost was usually already
// split as part of a grocery bill, and charging again for a toss would double-charge.
// Costs are only what a roommate said they paid; unpriced items count separately, never estimated.

import type { Database } from "bun:sqlite";
import { now } from "../clock";
import type { Item } from "./inventory";

export type LedgerKind = "wasted" | "rescued";

/** Write one ledger row for an item that was just tossed or rescued. */
export function recordLedger(db: Database, item: Item, kind: LedgerKind, memberId: number | null): void {
  db.run(
    `INSERT INTO ledger (household_id, item_id, member_id, kind, cost_cents, priced, shared, buyer_member_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.household_id,
      item.id,
      memberId,
      kind,
      item.cost_cents ?? 0,
      item.cost_cents === null ? 0 : 1,
      item.owner_member_id === null ? 1 : 0,
      item.buyer_member_id,
      now().toISOString(),
    ],
  );
}

export interface LedgerTotals {
  count: number;
  /** Sum of known prices only. */
  cents: number;
  /** Items nobody gave a price for. */
  unpriced: number;
}

export interface WasteSummary {
  wasted: LedgerTotals;
  rescued: LedgerTotals;
}

/**
 * Ledger totals for the household, optionally since N days ago and/or limited to one person's own
 * (personal) items. Totals carry no item or roommate names, so they're safe for the group.
 */
export function wasteSummary(db: Database, householdId: number, opts: { sinceDays?: number; ownerId?: number } = {}): WasteSummary {
  const since = opts.sinceDays === undefined ? "" : new Date(now().getTime() - opts.sinceDays * 86_400_000).toISOString();
  const byOwner = opts.ownerId !== undefined;
  const rows = db
    .query<{ kind: LedgerKind; count: number; cents: number; unpriced: number }, (number | string)[]>(
      `SELECT l.kind, COUNT(*) AS count, SUM(l.cost_cents) AS cents, SUM(1 - l.priced) AS unpriced
         FROM ledger l LEFT JOIN items i ON i.id = l.item_id
        WHERE l.household_id = ? AND l.at >= ?${byOwner ? " AND i.owner_member_id = ?" : ""}
        GROUP BY l.kind`,
    )
    .all(...[householdId, since, ...(byOwner ? [opts.ownerId!] : [])]);
  const empty = (): LedgerTotals => ({ count: 0, cents: 0, unpriced: 0 });
  const out: WasteSummary = { wasted: empty(), rescued: empty() };
  for (const r of rows) out[r.kind] = { count: r.count, cents: r.cents ?? 0, unpriced: r.unpriced ?? 0 };
  return out;
}
