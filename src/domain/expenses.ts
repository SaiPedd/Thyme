// Store expenses, their shares, and the balance entries they create. Undo and balances.
// All facts (amounts, who owes whom) are computed here; Claude only reports them.

import type { Database } from "bun:sqlite";
import { now } from "../clock";
import { computeSplit, debtsFromShares, expenseDedupeHash, type SplitSpec } from "./splits";

export interface RecordedExpense {
  id: number;
  totalCents: number;
  buyerId: number;
  mode: string;
  shares: { memberId: number; cents: number }[];
}

export class DuplicateExpenseError extends Error {
  constructor(readonly existingId: number) {
    super("looks like a duplicate of an expense already logged today");
  }
}

/** Local calendar date (YYYY-MM-DD) in the household time zone. */
export function localDate(tz: string, at: Date = now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function recordExpense(
  db: Database,
  input: {
    householdId: number;
    tz: string;
    spec: SplitSpec;
    description?: string;
    source?: "text" | "receipt";
    sourceMessageId?: string;
    /** Skip the duplicate check (the user confirmed it really is a second purchase). */
    allowDuplicate?: boolean;
    /** Who logged it, if not the buyer ("Sam paid"). Lets that person undo it. */
    loggedById?: number;
  },
): RecordedExpense {
  const { spec } = input;
  const { mode, shares } = computeSplit(spec);
  const at = now().toISOString();
  let hash = expenseDedupeHash(spec.buyerId, spec.totalCents, localDate(input.tz));

  const existing = db
    .query<{ id: number }, [string]>("SELECT id FROM expenses WHERE dedupe_hash = ? AND undone_at IS NULL")
    .get(hash);
  if (existing && !input.allowDuplicate) throw new DuplicateExpenseError(existing.id);
  // An undone or confirmed-duplicate expense still holds its hash (UNIQUE), so salt this one.
  if (db.query("SELECT 1 FROM expenses WHERE dedupe_hash = ?").get(hash)) hash = `${hash}:${crypto.randomUUID()}`;

  const id = db.transaction(() => {
    const row = db
      .query<{ id: number }, [number, number, number, string, string | null, string, string, string | null, string, number]>(
        `INSERT INTO expenses (household_id, buyer_member_id, total_cents, mode, description, source, dedupe_hash, source_message_id, created_at, logged_by_member_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(input.householdId, spec.buyerId, spec.totalCents, mode, input.description ?? null, input.source ?? "text", hash, input.sourceMessageId ?? null, at, input.loggedById ?? spec.buyerId)!;
    for (const [memberId, cents] of shares) {
      db.run("INSERT INTO expense_shares (expense_id, member_id, share_cents) VALUES (?, ?, ?)", [row.id, memberId, cents]);
    }
    for (const d of debtsFromShares(shares, spec.buyerId)) {
      db.run(
        `INSERT INTO balance_entries (household_id, debtor_member_id, creditor_member_id, amount_cents, source, source_id, created_at)
         VALUES (?, ?, ?, ?, 'expense', ?, ?)`,
        [input.householdId, d.debtorId, d.creditorId, d.amountCents, row.id, at],
      );
    }
    return row.id;
  })();

  return {
    id,
    totalCents: spec.totalCents,
    buyerId: spec.buyerId,
    mode,
    shares: [...shares].map(([memberId, cents]) => ({ memberId, cents })),
  };
}

/** Expenses this member can undo: ones they logged (older rows without a logger: ones they paid for). */
export const LOGGED_BY = "COALESCE(logged_by_member_id, buyer_member_id)";

/**
 * Undo the most recent active expense logged by this member. Returns it, or null if none.
 * A receipt's fridge items go too, unless someone already used or tossed them (that history stays).
 */
export function undoLastExpense(db: Database, householdId: number, memberId: number): { id: number; totalCents: number; itemsRemoved: string[] } | null {
  const last = db
    .query<{ id: number; total_cents: number }, [number, number]>(
      `SELECT id, total_cents FROM expenses
        WHERE household_id = ? AND ${LOGGED_BY} = ? AND undone_at IS NULL
        ORDER BY id DESC LIMIT 1`,
    )
    .get(householdId, memberId);
  if (!last) return null;
  const at = now().toISOString();
  const items = db
    .query<{ id: number; name: string }, [number]>(
      "SELECT id, name FROM items WHERE expense_id = ? AND status = 'fresh' AND id NOT IN (SELECT item_id FROM ledger WHERE item_id IS NOT NULL)",
    )
    .all(last.id);
  db.transaction(() => {
    db.run("UPDATE expenses SET undone_at = ? WHERE id = ?", [at, last.id]);
    db.run("UPDATE balance_entries SET undone_at = ? WHERE source = 'expense' AND source_id = ?", [at, last.id]);
    for (const it of items) {
      db.run("DELETE FROM nudges WHERE item_id = ?", [it.id]);
      db.run("DELETE FROM claims WHERE item_id = ?", [it.id]);
      db.run("DELETE FROM items WHERE id = ?", [it.id]);
    }
  })();
  return { id: last.id, totalCents: last.total_cents, itemsRemoved: items.map((i) => i.name) };
}

export interface BalanceLine {
  otherMemberId: number;
  /** Positive: the other person owes this member. Negative: this member owes them. */
  netCents: number;
}

/** Net balance between this member and each other member (expenses and shared waste combined). */
export function balancesFor(db: Database, householdId: number, memberId: number): { netCents: number; lines: BalanceLine[] } {
  const rows = db
    .query<{ other: number; net: number }, [number, number, number, number, number]>(
      `SELECT other, SUM(net) AS net FROM (
         SELECT debtor_member_id AS other, amount_cents AS net FROM balance_entries
          WHERE household_id = ? AND creditor_member_id = ? AND undone_at IS NULL
         UNION ALL
         SELECT creditor_member_id AS other, -amount_cents AS net FROM balance_entries
          WHERE household_id = ? AND debtor_member_id = ? AND undone_at IS NULL
       ) WHERE other <> ? GROUP BY other HAVING SUM(net) <> 0 ORDER BY other`,
    )
    .all(householdId, memberId, householdId, memberId, memberId);
  const lines = rows.map((r) => ({ otherMemberId: r.other, netCents: r.net }));
  return { netCents: lines.reduce((s, l) => s + l.netCents, 0), lines };
}
