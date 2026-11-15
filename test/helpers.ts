// Shared test helpers: an in-memory household and a fake adapter that records sends.

import type { Adapter, Destination, InboundMessage, SendOptions, SendResult, TextPart } from "../src/adapters/types";
import { openDb } from "../src/db";

export const PHONES = ["+16095550101", "+16095550102", "+16095550103"];

export function setupHousehold(opts: { mode?: "group" | "dm"; chatId?: string | null } = {}) {
  const db = openDb(":memory:");
  db.run("INSERT INTO households (id, name, chat_id, tz, mode, created_at) VALUES (1, 'Squad House', ?, 'America/New_York', ?, 't')", [
    opts.chatId === undefined ? "chat-1" : opts.chatId,
    opts.mode ?? "group",
  ]);
  ["Alex", "Sam", "Jordan"].forEach((name, i) =>
    db.run("INSERT INTO members (id, household_id, phone, name, created_at) VALUES (?, 1, ?, ?, 't')", [i + 1, PHONES[i]!, name]),
  );
  return db;
}

export class FakeAdapter implements Adapter {
  readonly name = "terminal" as const;
  sent: { destination: Destination; text: string; options: SendOptions }[] = [];
  /** Results to return, in order; defaults to accepted. */
  results: SendResult[] = [];
  reactions: { messageId: string; reaction: string }[] = [];
  private onMessage?: (m: InboundMessage) => void;

  async start(handlers: { onMessage: (m: InboundMessage) => void }) {
    this.onMessage = handlers.onMessage;
  }
  async send(destination: Destination, parts: TextPart[], options: SendOptions): Promise<SendResult> {
    this.sent.push({ destination, text: parts.map((p) => p.value).join(""), options });
    return this.results.shift() ?? { ok: true, status: "accepted", messageId: `m-${this.sent.length}` };
  }
  async react(messageId: string, reaction: string) {
    this.reactions.push({ messageId, reaction });
  }
  async stop() {}
  /** Simulate an inbound message. */
  receive(m: Partial<InboundMessage> & { from: string; text: string }) {
    this.onMessage?.({
      messageId: crypto.randomUUID(),
      chatId: m.isGroup === false ? `dm-${m.from}` : "chat-1",
      attachments: [],
      isGroup: true,
      ...m,
    });
  }
}

export const quietLog = () => {};
