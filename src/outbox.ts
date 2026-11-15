// Every outgoing message goes through here.
// - Privacy: project() resolves the audience; personal content can never reach the group.
// - Daily caps apply to PROACTIVE sends only; replies to someone who just texted go out immediately.
//   (No quiet hours: removed at the team's request, so reminders go out whenever they're due.)
// - Budget: refuse proactive sends once usage passes 90% of the monthly message budget.
// - Tracks each send (sends table), retries retryable failures, honors 429 Retry-After,
//   and counts usage locally. ok:true from Claw means accepted, never delivered.
// Logs never include message text or full phone numbers.

import type { Database } from "bun:sqlite";
import type { Adapter, Destination, SendResult } from "./adapters/types";
import { now } from "./clock";
import { mask } from "./domain/phone";
import { getHousehold, getMembers } from "./domain/household";
import { project, type Draft } from "./privacy/projection";

export type SendKind = "reply" | "proactive";

export interface OutboxOptions {
  monthlyBudget?: number;
  caps?: { memberPerDay: number; groupPerDay: number };
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Terminal mode: group messages go here while the household has no real group chat yet. */
  devGroupChatId?: string;
}

export interface SendOutcome {
  id: string;
  destination: Destination;
  status: "accepted" | "deferred" | "failed" | "refused";
  reason?: string;
}

function localParts(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, month: `${get("year")}-${get("month")}`, hour: Number(get("hour")) };
}

const destKey = (d: Destination) => (d.kind === "group" ? { chat_id: d.chatId, to_phone: null } : { chat_id: null, to_phone: d.phone });
const destLabel = (d: Destination) => (d.kind === "group" ? "group" : mask(d.phone));

export class Outbox {
  private readonly budget: number;
  private readonly caps: { memberPerDay: number; groupPerDay: number };
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly devGroupChatId?: string;

  constructor(
    private readonly db: Database,
    private readonly adapter: Adapter,
    options: OutboxOptions = {},
  ) {
    this.devGroupChatId = options.devGroupChatId;
    this.budget = options.monthlyBudget ?? 2000;
    this.caps = options.caps ?? { memberPerDay: 3, groupPerDay: 4 };
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = options.log ?? ((l) => console.log(l));
  }

  /** Count an inbound message against the monthly budget. */
  recordInbound(): void {
    const tz = getHousehold(this.db)?.tz ?? "UTC";
    this.bump(localParts(tz, now()).month, "inbound");
  }

  usage(): { inbound: number; outbound: number; proactive: number } {
    const tz = getHousehold(this.db)?.tz ?? "UTC";
    const row = this.db
      .query<{ inbound: number; outbound: number; proactive: number }, [string]>(
        "SELECT inbound, outbound, proactive FROM usage_counters WHERE month = ?",
      )
      .get(localParts(tz, now()).month);
    return row ?? { inbound: 0, outbound: 0, proactive: 0 };
  }

  async send(draft: Draft, opts: { kind: SendKind; replyTo?: string }): Promise<SendOutcome[]> {
    const stored = getHousehold(this.db);
    if (!stored) throw new Error("no household: run `bun run seed` first");
    const household = { ...stored, chat_id: stored.chat_id ?? this.devGroupChatId ?? null };
    const destinations = project(draft, household, getMembers(this.db, household.id));
    const outcomes: SendOutcome[] = [];
    for (const destination of destinations) {
      outcomes.push(await this.sendOne(destination, draft.text, opts, household.tz));
    }
    return outcomes;
  }

  private async sendOne(destination: Destination, text: string, opts: { kind: SendKind; replyTo?: string }, tz: string): Promise<SendOutcome> {
    const id = crypto.randomUUID();
    const at = now();
    const key = destKey(destination);
    const insert = (status: string, notBefore: string | null, lastError: string | null) =>
      this.db.run(
        `INSERT INTO sends (id, audience, chat_id, to_phone, kind, status, not_before, last_error, created_at, body, reply_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, destination.kind, key.chat_id, key.to_phone, opts.kind, status, notBefore, lastError, at.toISOString(), text, opts.replyTo ?? null],
      );

    if (opts.kind === "proactive") {
      const u = this.usage();
      if (u.inbound + u.outbound >= this.budget * 0.9) {
        insert("failed", null, "refused: over 90% of monthly budget");
        this.log(`[out] ${destLabel(destination)} proactive refused (budget)`);
        return { id, destination, status: "refused", reason: "budget" };
      }
      if (this.sentToday(destination, tz) >= (destination.kind === "group" ? this.caps.groupPerDay : this.caps.memberPerDay)) {
        insert("failed", null, "refused: daily cap");
        this.log(`[out] ${destLabel(destination)} proactive refused (daily cap)`);
        return { id, destination, status: "refused", reason: "daily cap" };
      }
    }

    insert("queued", null, null);
    return this.deliver(id, destination, text, opts.kind, tz, opts.replyTo);
  }

  /** Send deferred rows whose time has come (called by the scheduler). Nothing defers now that quiet
   *  hours are gone, but this still sends any message an older run held back. */
  async flushDue(): Promise<SendOutcome[]> {
    const tz = getHousehold(this.db)?.tz ?? "UTC";
    const due = this.db
      .query<{ id: string; chat_id: string | null; to_phone: string | null; kind: string; body: string | null; reply_to: string | null }, [string]>(
        "SELECT id, chat_id, to_phone, kind, body, reply_to FROM sends WHERE status = 'deferred' AND not_before <= ? ORDER BY created_at",
      )
      .all(now().toISOString());
    const out: SendOutcome[] = [];
    for (const row of due) {
      const destination: Destination = row.chat_id ? { kind: "group", chatId: row.chat_id } : { kind: "member", phone: row.to_phone! };
      this.db.run("UPDATE sends SET status = 'queued' WHERE id = ?", [row.id]);
      out.push(await this.deliver(row.id, destination, row.body ?? "", row.kind as SendKind, tz, row.reply_to ?? undefined));
    }
    return out;
  }

  /** Apply a delivery status event (delivered / read / failed). */
  markStatus(ev: { messageId?: string; id?: string; status: string }): void {
    const status = ["delivered", "read", "failed"].includes(ev.status) ? ev.status : null;
    if (!status) return;
    if (ev.id) this.db.run("UPDATE sends SET status = ? WHERE id = ?", [status, ev.id]);
    else if (ev.messageId) this.db.run("UPDATE sends SET status = ? WHERE message_id = ?", [status, ev.messageId]);
  }

  private async deliver(id: string, destination: Destination, text: string, kind: SendKind, tz: string, replyTo?: string): Promise<SendOutcome> {
    let result: SendResult = { ok: false, status: "failed", error: "not attempted" };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this.db.run("UPDATE sends SET attempts = ? WHERE id = ?", [attempt, id]);
      try {
        result = await this.adapter.send(destination, [{ type: "text", value: text }], { id: attempt === 1 ? id : `${id}:${attempt}`, replyTo });
      } catch (error) {
        result = { ok: false, status: "failed", retryable: true, error: (error as Error).message };
      }
      if (result.ok) break;
      if (!result.retryable && result.retryAfterMs === undefined) break;
      if (attempt < this.maxAttempts) await this.sleep(result.retryAfterMs ?? 500 * 2 ** (attempt - 1));
    }

    if (result.ok) {
      this.db.run("UPDATE sends SET status = 'accepted', message_id = ?, last_error = NULL WHERE id = ?", [result.messageId ?? null, id]);
      const month = localParts(tz, now()).month;
      this.bump(month, "outbound");
      if (kind === "proactive") this.bump(month, "proactive");
      this.log(`[out] ${destLabel(destination)} ${kind} accepted`);
      return { id, destination, status: "accepted" };
    }
    this.db.run("UPDATE sends SET status = 'failed', last_error = ? WHERE id = ?", [String(result.error ?? result.status).slice(0, 200), id]);
    this.log(`[out] ${destLabel(destination)} ${kind} failed (${result.status})`);
    return { id, destination, status: "failed", reason: result.error ?? result.status };
  }

  private sentToday(destination: Destination, tz: string): number {
    const key = destKey(destination);
    const since = new Date(now().getTime() - 36 * 3600_000).toISOString();
    const rows = this.db
      .query<{ created_at: string }, [string | null, string | null, string]>(
        `SELECT created_at FROM sends WHERE kind = 'proactive' AND status IN ('accepted','delivered','read','deferred','queued')
           AND chat_id IS ? AND to_phone IS ? AND created_at >= ?`,
      )
      .all(key.chat_id, key.to_phone, since);
    const today = localParts(tz, now()).date;
    return rows.filter((r) => localParts(tz, new Date(r.created_at)).date === today).length;
  }

  private bump(month: string, field: "inbound" | "outbound" | "proactive"): void {
    this.db.run(`INSERT INTO usage_counters (month, ${field}) VALUES (?, 1) ON CONFLICT(month) DO UPDATE SET ${field} = ${field} + 1`, [month]);
  }
}
