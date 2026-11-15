// Claw Messenger adapter: one WebSocket (Bun built-in), with
// - app-level ping every 30 s, pong to server pings, reconnect if idle 300 s
// - exponential reconnect backoff capped at 30 s
// - `sync` since the last seen message after every (re)connect; replays are deduped by the Inbox
// - each send waits for its send.result (ok:true = accepted, NOT delivered)
// Never logs the API key, the WebSocket URL, message text, or full phone numbers.

import type { Adapter, Destination, InboundMessage, SendOptions, SendResult, StatusEvent, Tapback, TextPart } from "./types";
import { mask } from "../domain/phone";

const BASE = "https://claw-messenger.onrender.com";
const PING_MS = 30_000;
const IDLE_MS = 300_000;
const MAX_BACKOFF_MS = 30_000;
const SEND_TIMEOUT_MS = 15_000;

export interface ClawOptions {
  apiKey: string;
  /** Last seen inbound time, for sync after reconnect. */
  lastSeenAt: () => string | null;
  log?: (line: string) => void;
}

type Handlers = { onMessage: (m: InboundMessage) => void; onStatus?: (s: StatusEvent) => void };

/** North American 555-0100..0199 numbers are reserved for fiction. */
export const isFictional = (phone: string) => /^\+1\d{3}55501\d{2}$/.test(phone);

export class ClawAdapter implements Adapter {
  readonly name = "claw" as const;
  private ws: WebSocket | null = null;
  private handlers: Handlers | null = null;
  private stopped = false;
  private backoff = 1000;
  private lastFrame = 0;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private waiting = new Map<string, (r: SendResult) => void>();
  private openWaiters: (() => void)[] = [];
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ClawOptions) {
    this.log = opts.log ?? ((l) => console.log(l));
  }

  /** Readiness check (GET /api/agent/readiness). */
  static async readiness(apiKey: string): Promise<{ status: number; ready: boolean }> {
    const res = await fetch(`${BASE}/api/agent/readiness`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const body = (await res.json().catch(() => ({}))) as { ready?: boolean };
    return { status: res.status, ready: body.ready === true };
  }

  async start(handlers: Handlers): Promise<void> {
    this.handlers = handlers;
    this.connect();
    this.pinger = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        if (performance.now() - this.lastFrame > IDLE_MS) {
          this.log("[claw] idle too long, reconnecting");
          this.ws.close();
          return;
        }
        this.raw({ type: "ping" });
      }
    }, PING_MS);
  }

  private connect() {
    if (this.stopped) return;
    const ws = new WebSocket(`${BASE.replace("https", "wss")}/ws?key=${encodeURIComponent(this.opts.apiKey)}`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.backoff = 1000;
      this.lastFrame = performance.now();
      this.log("[claw] connected");
      const since = this.opts.lastSeenAt();
      if (since) this.raw({ type: "sync", since });
      for (const w of this.openWaiters.splice(0)) w();
    });
    ws.addEventListener("message", (event) => this.onFrame(String(event.data)));
    ws.addEventListener("error", () => this.log("[claw] websocket error (details withheld)"));
    ws.addEventListener("close", (e) => {
      if (this.ws === ws) this.ws = null;
      // Fail sends still waiting on this socket; the outbox retries them.
      for (const [id, resolve] of this.waiting) resolve({ ok: false, status: "failed", retryable: true, error: "connection closed" });
      this.waiting.clear();
      if (this.stopped) return;
      this.log(`[claw] closed (code ${e.code}), reconnecting in ${Math.round(this.backoff / 1000)}s`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
  }

  private raw(msg: Record<string, unknown>) {
    this.ws?.send(JSON.stringify(msg));
  }

  private onFrame(data: string) {
    this.lastFrame = performance.now();
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "ping":
        this.raw({ type: "pong" });
        return;
      case "pong":
        return;
      case "send.result": {
        const resolve = this.waiting.get(msg.id);
        if (!resolve) return;
        this.waiting.delete(msg.id);
        const retryAfter = msg.retryAfter ?? msg.retry_after ?? msg.retryAfterSeconds;
        resolve({
          ok: msg.ok === true,
          status: String(msg.status ?? (msg.ok ? "accepted" : "failed")),
          messageId: msg.messageId,
          chatId: msg.chatId,
          retryable: msg.retryable === true,
          retryAfterMs: retryAfter !== undefined ? Number(retryAfter) * 1000 : undefined,
          error: msg.ok ? undefined : String(msg.error ?? msg.detail ?? msg.status ?? "failed"),
        });
        return;
      }
      case "status":
        this.handlers?.onStatus?.({ id: msg.id, messageId: msg.messageId, status: String(msg.status) });
        return;
      case "sync.done":
        this.log("[claw] sync done");
        return;
      case "message":
        if (!msg.messageId || !msg.from) return;
        this.handlers?.onMessage({
          messageId: String(msg.messageId),
          chatId: String(msg.chatId ?? ""),
          from: String(msg.from),
          text: typeof msg.text === "string" ? msg.text : "",
          attachments: Array.isArray(msg.attachments) ? msg.attachments.filter((a: any) => a?.url) : [],
          isGroup: msg.isGroup === true,
          participants: Array.isArray(msg.participants) ? msg.participants : undefined,
          sentAt: typeof msg.sentAt === "string" ? msg.sentAt : undefined,
          replyTo: msg.replyTo?.messageId ? { messageId: String(msg.replyTo.messageId) } : undefined,
          replay: msg.replay === true,
        });
        return;
      default:
        return;
    }
  }

  private async whenOpen(timeoutMs: number): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) return true;
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.openWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  async send(destination: Destination, parts: TextPart[], options: SendOptions): Promise<SendResult> {
    // Seeded demo roommates use fictional 555-01xx numbers. Never send to them: a send to a new
    // number auto-registers it and would burn one of the plan's registered-number slots.
    if (destination.kind === "member" && isFictional(destination.phone)) {
      return { ok: false, status: "failed", retryable: false, error: "fictional demo number" };
    }
    if (!(await this.whenOpen(10_000))) return { ok: false, status: "failed", retryable: true, error: "not connected" };
    const msg: Record<string, unknown> = { type: "send", id: options.id, parts };
    if (destination.kind === "group") msg.chatId = destination.chatId;
    else msg.to = destination.phone;
    if (options.replyTo) msg.replyTo = { messageId: options.replyTo };

    const result = await new Promise<SendResult>((resolve) => {
      const t = setTimeout(() => {
        this.waiting.delete(options.id);
        resolve({ ok: false, status: "failed", retryable: true, error: "no send.result" });
      }, SEND_TIMEOUT_MS);
      this.waiting.set(options.id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      this.raw(msg);
    });
    if (!result.ok) {
      const to = destination.kind === "group" ? "group" : mask(destination.phone);
      this.log(`[claw] send to ${to} not accepted: ${result.status}${result.retryable ? " (retryable)" : ""}`);
    }
    return result;
  }

  async typing(destination: Destination, on: boolean): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const target = destination.kind === "group" ? { chatId: destination.chatId } : { to: destination.phone };
    this.raw({ type: on ? "typing.start" : "typing.stop", ...target });
  }

  async react(messageId: string, reaction: Tapback): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.raw({ type: "reaction", id: crypto.randomUUID(), messageId, reactionType: reaction, remove: false });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pinger) clearInterval(this.pinger);
    this.ws?.close();
  }
}
