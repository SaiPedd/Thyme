// Inbound pipeline, shared by every adapter:
// - dedupe by messageId (seen_messages), so replays and redeliveries run once
// - remember the newest sentAt (state.last_seen_at) for `sync` after a reconnect
// - debounce rapid messages from one sender in one chat (2 s), merged into one turn
// - serialize processing per chat, so one chat's turns never interleave

import type { Database } from "bun:sqlite";
import type { InboundMessage } from "./adapters/types";
import { now } from "./clock";

export type TurnHandler = (merged: InboundMessage) => Promise<void>;

export class Inbox {
  private pending = new Map<string, { messages: InboundMessage[]; timer: ReturnType<typeof setTimeout> }>();
  private chains = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly handler: TurnHandler,
    private readonly opts: { debounceMs?: number; onAccepted?: () => void; log?: (l: string) => void } = {},
  ) {}

  /** Returns false if the message was a duplicate. */
  push(m: InboundMessage): boolean {
    const fresh = this.db.run("INSERT OR IGNORE INTO seen_messages (message_id, chat_id, received_at) VALUES (?, ?, ?)", [
      m.messageId,
      m.chatId,
      now().toISOString(),
    ]);
    if (fresh.changes === 0) return false;
    this.opts.onAccepted?.();
    const seen = m.sentAt ?? now().toISOString();
    this.db.run(
      `INSERT INTO state (key, value) VALUES ('last_seen_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)`,
      [seen],
    );

    const key = `${m.chatId}|${m.from}`;
    const entry = this.pending.get(key);
    if (entry) clearTimeout(entry.timer);
    const messages = [...(entry?.messages ?? []), m];
    const timer = setTimeout(() => this.release(key), this.opts.debounceMs ?? 2000);
    this.pending.set(key, { messages, timer });
    return true;
  }

  lastSeenAt(): string | null {
    return this.db.query<{ value: string }, []>("SELECT value FROM state WHERE key = 'last_seen_at'").get()?.value ?? null;
  }

  /** Process everything waiting now (tests and shutdown). */
  async drain(): Promise<void> {
    for (const [key, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.release(key);
    }
    await Promise.all(this.chains.values());
  }

  private release(key: string) {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    const merged = merge(entry.messages);
    const chat = merged.chatId;
    const run = (this.chains.get(chat) ?? Promise.resolve())
      .then(() => this.handler(merged))
      .catch((e) => this.opts.log?.(`[inbox] turn failed: ${(e as Error).name}`));
    this.chains.set(chat, run);
  }
}

function merge(messages: InboundMessage[]): InboundMessage {
  const last = messages.at(-1)!;
  if (messages.length === 1) return last;
  return {
    ...last,
    text: messages.map((m) => m.text).filter(Boolean).join("\n"),
    attachments: messages.flatMap((m) => m.attachments),
    sentAt: messages[0]!.sentAt ?? last.sentAt,
    replyTo: messages.find((m) => m.replyTo)?.replyTo,
  };
}
