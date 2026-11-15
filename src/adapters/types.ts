// One adapter interface for every channel: claw (Claw Messenger WebSocket) and terminal (dev).

export interface InboundMessage {
  messageId: string;
  chatId: string;
  /** Sender, +E.164. */
  from: string;
  text: string;
  attachments: { url: string; mimeType?: string }[];
  isGroup: boolean;
  participants?: string[];
  /** ISO time the sender sent it, when the channel provides it. */
  sentAt?: string;
  replyTo?: { messageId: string };
  /** Replayed by a sync after reconnect. */
  replay?: boolean;
}

/** Where a message is delivered. Resolved by src/privacy/projection.ts, never by the LLM. */
export type Destination = { kind: "group"; chatId: string } | { kind: "member"; phone: string };

export interface TextPart {
  type: "text";
  value: string;
}

export interface SendOptions {
  /** Our unique id for this send (also used as the Claw "id"). */
  id: string;
  replyTo?: string;
}

export interface SendResult {
  ok: boolean;
  /** accepted | failed | ... ok means accepted, NOT delivered. */
  status: string;
  messageId?: string;
  chatId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  error?: string;
}

export type Tapback = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

export interface StatusEvent {
  messageId?: string;
  id?: string;
  status: string;
}

export interface Adapter {
  readonly name: "claw" | "terminal";
  /** Start receiving. Handlers are called for every inbound message and delivery status. */
  start(handlers: { onMessage: (m: InboundMessage) => void; onStatus?: (s: StatusEvent) => void }): Promise<void>;
  send(destination: Destination, parts: TextPart[], options: SendOptions): Promise<SendResult>;
  react?(messageId: string, reaction: Tapback): Promise<void>;
  typing?(destination: Destination, on: boolean): Promise<void>;
  stop(): Promise<void>;
}
