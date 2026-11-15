// Proactive work, ticked every few seconds by index.ts:
// - send deferred messages (quiet hours) once they're due
// - once a day at 09:00 household time, remind about food expiring within 48h:
//   shared items to the group, personal items to the owner's DM; one retry the next morning, then stop.
// Every message goes through the outbox (quiet hours, caps, budget, privacy projection).
// The wording is fixed here (code owns the facts); a reminder only opens a conversation.

import type { Database } from "bun:sqlite";
import { now, setOffsetMs } from "./clock";
import { localDate } from "./domain/expenses";
import { getHousehold, getMembers, type Household } from "./domain/household";
import { agree, AT_RISK_MS, expiryPhrase, isPast, isPlural, type Item } from "./domain/inventory";
import type { Outbox, SendOutcome } from "./outbox";
import type { Draft } from "./privacy/projection";

export const DAILY_HOUR = 9;
export const CLOCK_OFFSET_KEY = "clock_offset_ms";

export interface DailyReport {
  date: string;
  groupItems: number[];
  memberItems: Record<number, number[]>;
}

/** Apply the demo clock offset saved by `bun run time-travel`, so a running agent follows it. */
export function syncClockFromDb(db: Database): void {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(CLOCK_OFFSET_KEY);
  setOffsetMs(Number(row?.value ?? 0) || 0);
}

function localHour(tz: string, at: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(at));
}

const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** Group reminder for shared items. Past-date items are only ever "toss it", never offered. */
export function groupReminderText(items: Item[], tz: string, retry: boolean): string {
  const at = now();
  const past = items.filter((i) => isPast(i, at));
  const soon = items.filter((i) => !isPast(i, at));
  const lines: string[] = [];
  if (soon.length) {
    lines.push(`${retry ? "Reminder" : "Heads up"}: ${list(soon.map((i) => `the ${i.name} ${agree(i.name, expiryPhrase(i, tz, null, at))}`))}.`);
    const one = soon.length === 1 && !isPlural(soon[0]!.name);
    lines.push(soon.length === 1 ? `Anyone want ${one ? "it" : "them"}? Reply "mine" to claim ${one ? "it" : "them"}.` : `Anyone want them? Reply "I'll take the ${soon[0]!.name}" to claim one.`);
  }
  if (past.length) {
    const one = past.length === 1 && !isPlural(past[0]!.name);
    lines.push(`The ${list(past.map((i, n) => (n === 0 ? i.name : `the ${i.name}`)))} ${one ? "is" : "are"} past the USDA FoodKeeper date. To be safe, toss ${one ? "it" : "them"} and tell me "tossed the ${past[0]!.name}".`);
  }
  return lines.join("\n");
}

/** DM reminder for one person's own items. */
export function memberReminderText(items: Item[], tz: string, retry: boolean): string {
  const at = now();
  const lines: string[] = [];
  for (const i of items) {
    const [is, it] = isPlural(i.name) ? ["are", "them"] : ["is", "it"];
    if (isPast(i, at)) lines.push(`Your ${i.name} ${is} past the USDA FoodKeeper date. To be safe, toss ${it} and tell me "tossed the ${i.name}".`);
    else lines.push(`${retry ? "Reminder: your" : "Your"} ${i.name} ${agree(i.name, expiryPhrase(i, tz, null, at))}. Tell me "used the ${i.name}" once ${isPlural(i.name) ? "they're" : "it's"} eaten.`);
  }
  return lines.join("\n");
}

export class Scheduler {
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly outbox: Outbox,
    private readonly opts: { groupChatId?: string; log?: (line: string) => void } = {},
  ) {}

  private log(line: string) {
    (this.opts.log ?? console.log)(line);
  }

  /** One scheduler pass. Safe to call often; overlapping calls are skipped. */
  async tick(): Promise<DailyReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      await this.outbox.flushDue();
      const household = getHousehold(this.db);
      if (!household) return null;
      const at = now();
      if (localHour(household.tz, at) < DAILY_HOUR) return null;
      const key = `daily:${localDate(household.tz, at)}`;
      if (this.db.run("INSERT OR IGNORE INTO state (key, value) VALUES (?, ?)", [key, at.toISOString()]).changes === 0) return null;
      return await this.runDaily(household);
    } finally {
      this.running = false;
    }
  }

  /** The 09:00 job: find at-risk items and send each reminder once (attempt 1, then one retry on a later day). */
  async runDaily(household: Household): Promise<DailyReport> {
    const at = now();
    const today = localDate(household.tz, at);
    const report: DailyReport = { date: today, groupItems: [], memberItems: {} };
    const items = this.db
      .query<Item, [number, string]>(
        `SELECT * FROM items WHERE household_id = ? AND status = 'fresh' AND expires_at IS NOT NULL AND expires_at <= ?
         ORDER BY expires_at, id`,
      )
      .all(household.id, new Date(at.getTime() + AT_RISK_MS).toISOString());

    const due: { item: Item; attempt: 1 | 2 }[] = [];
    for (const item of items) {
      const last = this.db
        .query<{ attempt: number; sent_at: string; responded_at: string | null }, [number]>(
          "SELECT attempt, sent_at, responded_at FROM nudges WHERE item_id = ? ORDER BY attempt DESC LIMIT 1",
        )
        .get(item.id);
      const claimed = this.db.query("SELECT 1 FROM claims WHERE item_id = ? AND won = 1").get(item.id);
      if (claimed) continue;
      if (!last) due.push({ item, attempt: 1 });
      else if (last.attempt === 1 && !last.responded_at && localDate(household.tz, new Date(last.sent_at)) < today) due.push({ item, attempt: 2 });
    }
    if (due.length === 0) return report;

    const members = getMembers(this.db, household.id);
    const shared = due.filter((d) => d.item.owner_member_id === null);
    if (shared.length) {
      const text = groupReminderText(shared.map((d) => d.item), household.tz, shared.every((d) => d.attempt === 2));
      const outcomes = await this.outbox.send({ audience: { kind: "group" }, text, sensitivity: "household" }, { kind: "proactive" });
      if (this.record(shared, "group", null, outcomes)) {
        report.groupItems = shared.map((d) => d.item.id);
        // Keep the reminder in the group's history so the agent understands "mine" replies.
        const chatId = household.chat_id ?? this.opts.groupChatId;
        if (chatId) {
          this.db.run("INSERT INTO turns (chat_id, member_id, role, content, created_at) VALUES (?, NULL, 'assistant', ?, ?)", [chatId, text, at.toISOString()]);
        }
      }
    }

    for (const m of members) {
      const mine = due.filter((d) => d.item.owner_member_id === m.id);
      if (!mine.length) continue;
      const draft: Draft = {
        audience: { kind: "member", memberId: m.id },
        text: memberReminderText(mine.map((d) => d.item), household.tz, mine.every((d) => d.attempt === 2)),
        sensitivity: "personal",
        subjectMemberId: m.id,
      };
      const outcomes = await this.outbox.send(draft, { kind: "proactive" });
      if (this.record(mine, "member", m.id, outcomes)) report.memberItems[m.id] = mine.map((d) => d.item.id);
    }
    this.log(`[scheduler] ${today}: reminded ${report.groupItems.length} shared, ${Object.values(report.memberItems).flat().length} personal item(s)`);
    return report;
  }

  /** Save nudges when the message was accepted or deferred to morning. Refused/failed: try again tomorrow. */
  private record(due: { item: Item; attempt: 1 | 2 }[], audience: "group" | "member", memberId: number | null, outcomes: SendOutcome[]): boolean {
    const sent = outcomes.find((o) => o.status === "accepted" || o.status === "deferred");
    if (!sent) return false;
    const at = now().toISOString();
    for (const d of due) {
      this.db.run(
        "INSERT OR IGNORE INTO nudges (item_id, audience, member_id, attempt, send_id, sent_at) VALUES (?, ?, ?, ?, ?, ?)",
        [d.item.id, audience, memberId, d.attempt, sent.id, at],
      );
    }
    return true;
  }
}
