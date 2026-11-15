// Claims on shared items ("mine", "I'll take the spinach"). Code decides the winner: the earliest
// claim by sentAt (receive time if the channel gave none), ties broken by arrival order. If an
// earlier claim arrives late (debounce, reconnect sync), it takes over and the replaced winner is reported.

import type { Database } from "bun:sqlite";
import { now } from "../clock";

export interface ClaimOutcome {
  won: boolean;
  winnerMemberId: number;
  /** The member who held the item until this (earlier) claim arrived. */
  replacedMemberId?: number;
  /** This member had already claimed it. */
  repeat?: boolean;
}

/** Normalize a channel timestamp so claims compare correctly as strings. */
export function claimTime(sentAt: string | undefined): string {
  const t = sentAt ? Date.parse(sentAt) : NaN;
  return Number.isNaN(t) ? now().toISOString() : new Date(t).toISOString();
}

export function claimItem(db: Database, itemId: number, memberId: number, messageId: string | null, claimedAt: string): ClaimOutcome {
  return db.transaction((): ClaimOutcome => {
    const winnerRow = () =>
      db.query<{ id: number; member_id: number }, [number]>("SELECT id, member_id FROM claims WHERE item_id = ? ORDER BY claimed_at, id LIMIT 1").get(itemId)!;
    const current = db.query<{ id: number; member_id: number }, [number]>("SELECT id, member_id FROM claims WHERE item_id = ? AND won = 1").get(itemId);

    const mine = db.query<{ id: number }, [number, number]>("SELECT id FROM claims WHERE item_id = ? AND member_id = ?").get(itemId, memberId);
    if (mine) {
      const winner = winnerRow();
      return { won: winner.member_id === memberId, winnerMemberId: winner.member_id, repeat: true };
    }

    db.run("INSERT INTO claims (item_id, member_id, message_id, claimed_at, won, created_at) VALUES (?, ?, ?, ?, 0, ?)", [
      itemId,
      memberId,
      messageId,
      claimedAt,
      now().toISOString(),
    ]);
    const winner = winnerRow();
    if (current?.id !== winner.id) {
      if (current) db.run("UPDATE claims SET won = 0 WHERE id = ?", [current.id]);
      db.run("UPDATE claims SET won = 1 WHERE id = ?", [winner.id]);
    }
    db.run("UPDATE nudges SET responded_at = ? WHERE item_id = ? AND responded_at IS NULL", [now().toISOString(), itemId]);
    return {
      won: winner.member_id === memberId,
      winnerMemberId: winner.member_id,
      ...(current && current.member_id !== winner.member_id ? { replacedMemberId: current.member_id } : {}),
    };
  })();
}

/** Who holds an item, if anyone claimed it. */
export function claimWinner(db: Database, itemId: number): number | null {
  return db.query<{ member_id: number }, [number]>("SELECT member_id FROM claims WHERE item_id = ? AND won = 1").get(itemId)?.member_id ?? null;
}
