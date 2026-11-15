// Settling up: "I paid Alex back $12", "Sam paid me back", "Alex and I are square".
// A payment is a balance entry in the opposite direction of the debt (the payee now "owes" the payer
// the amount), so it nets against expenses in balance_entries. Code decides every amount: with no
// amount given, it is exactly what is owed right now. Paying more than is owed is refused.

import type { Database } from "bun:sqlite";
import { now } from "../clock";
import { balancesFor } from "./expenses";

export class PaymentError extends Error {}

/** What `fromId` owes `toId` right now, in cents (0 if nothing, or if it's the other way round). */
export function owedBetween(db: Database, householdId: number, fromId: number, toId: number): number {
  const line = balancesFor(db, householdId, fromId).lines.find((l) => l.otherMemberId === toId);
  return line && line.netCents < 0 ? -line.netCents : 0;
}

export interface RecordedPayment {
  id: number;
  fromId: number;
  toId: number;
  amountCents: number;
  /** What `fromId` still owes `toId` afterwards (0 = square). */
  stillOwedCents: number;
}

export function recordPayment(
  db: Database,
  input: {
    householdId: number;
    fromId: number;
    toId: number;
    /** null = pay off exactly what is owed. */
    amountCents: number | null;
    loggedById: number;
    sourceMessageId?: string;
  },
): RecordedPayment {
  const { householdId, fromId, toId } = input;
  if (fromId === toId) throw new PaymentError("someone can't pay themselves");
  const owed = owedBetween(db, householdId, fromId, toId);
  if (owed === 0) throw new PaymentError("nothing is owed");
  const amount = input.amountCents ?? owed;
  if (!Number.isInteger(amount) || amount <= 0) throw new PaymentError("the amount must be positive");
  if (amount > owed) throw new PaymentError(`more than is owed (${owed} cents)`);

  const at = now().toISOString();
  const id = db.transaction(() => {
    const row = db
      .query<{ id: number }, [number, number, number, number, number, string | null, string]>(
        `INSERT INTO payments (household_id, from_member_id, to_member_id, amount_cents, logged_by_member_id, source_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(householdId, fromId, toId, amount, input.loggedById, input.sourceMessageId ?? null, at)!;
    // The payee now "owes" the payer this much, which cancels the debt.
    db.run(
      `INSERT INTO balance_entries (household_id, debtor_member_id, creditor_member_id, amount_cents, source, source_id, created_at)
       VALUES (?, ?, ?, ?, 'payment', ?, ?)`,
      [householdId, toId, fromId, amount, row.id, at],
    );
    return row.id;
  })();
  return { id, fromId, toId, amountCents: amount, stillOwedCents: owed - amount };
}

/** The member's most recent active payment they logged, with its time, or null. */
export function lastPayment(db: Database, householdId: number, memberId: number) {
  return db
    .query<{ id: number; from_member_id: number; to_member_id: number; amount_cents: number; created_at: string }, [number, number]>(
      `SELECT id, from_member_id, to_member_id, amount_cents, created_at FROM payments
        WHERE household_id = ? AND logged_by_member_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(householdId, memberId);
}

export function undoPayment(db: Database, paymentId: number): void {
  const at = now().toISOString();
  db.transaction(() => {
    db.run("UPDATE payments SET undone_at = ? WHERE id = ?", [at, paymentId]);
    db.run("UPDATE balance_entries SET undone_at = ? WHERE source = 'payment' AND source_id = ?", [at, paymentId]);
  })();
}
