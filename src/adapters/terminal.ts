// Terminal adapter (dev only): plain stdin/stdout, spends no Claw messages.
// Type a message to send it as the current roommate. Commands:
//   /as <name>   switch who you are       /group   talk in the household group
//   /dm          talk in your own DM      /who     show who and where you are
//   /photo <path> [caption]   send a local image as a photo (e.g. a receipt)
// This is the only place message text is printed, because it's the chat UI itself.

import type { Adapter, Destination, InboundMessage, SendOptions, SendResult, TextPart } from "./types";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { now } from "../clock";

export interface TerminalMember {
  name: string;
  phone: string;
}

export class TerminalAdapter implements Adapter {
  readonly name = "terminal" as const;
  private current: TerminalMember;
  private inGroup = true;
  private running = false;
  private counter = 0;

  constructor(
    private readonly members: TerminalMember[],
    private readonly groupChatId: string,
    private readonly botName: string,
    private readonly out: (line: string) => void = (l) => console.log(l),
  ) {
    if (members.length === 0) throw new Error("terminal adapter needs household members: run `bun run seed`");
    this.current = members[0]!;
  }

  private where() {
    return this.inGroup ? "group" : `DM`;
  }

  private prompt() {
    this.out(`(${this.current.name} in ${this.where()}) type a message, or /as <name>, /group, /dm, /who, /photo <path>`);
  }

  async start(handlers: { onMessage: (m: InboundMessage) => void }): Promise<void> {
    this.running = true;
    this.prompt();
    (async () => {
      for await (const raw of console) {
        if (!this.running) break;
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith("/as ")) {
          const name = line.slice(4).trim().toLowerCase();
          const m = this.members.find((x) => x.name.toLowerCase().startsWith(name));
          if (m) this.current = m;
          else this.out(`no roommate named ${name}. Roommates: ${this.members.map((x) => x.name).join(", ")}`);
          this.prompt();
          continue;
        }
        if (line === "/group" || line === "/dm") {
          this.inGroup = line === "/group";
          this.prompt();
          continue;
        }
        if (line === "/who") {
          this.prompt();
          continue;
        }
        let text = line;
        let attachments: InboundMessage["attachments"] = [];
        if (line.startsWith("/photo ")) {
          // "/photo ~/Desktop/receipt.jpg Sam paid": path, then an optional caption.
          const [rawPath = "", ...caption] = line.slice(7).trim().split(/\s+/);
          const path = resolve(rawPath.replace(/^~(?=\/|$)/, homedir()));
          attachments = [{ url: `file://${path}` }];
          text = caption.join(" ");
        }
        this.counter++;
        handlers.onMessage({
          messageId: `term-${now().getTime()}-${this.counter}`,
          chatId: this.inGroup ? this.groupChatId : `term-dm-${this.current.phone}`,
          from: this.current.phone,
          text,
          attachments,
          isGroup: this.inGroup,
          participants: this.members.map((m) => m.phone),
          sentAt: now().toISOString(),
        });
      }
    })();
  }

  async send(destination: Destination, parts: TextPart[], options: SendOptions): Promise<SendResult> {
    const to = destination.kind === "group" ? "group" : `DM to ${this.members.find((m) => m.phone === destination.phone)?.name ?? "?"}`;
    const text = parts.map((p) => p.value).join("");
    this.out(`\n[${this.botName} -> ${to}]\n${text}\n`);
    return { ok: true, status: "accepted", messageId: `term-out-${options.id}` };
  }

  async react(_messageId: string, reaction: string): Promise<void> {
    this.out(`[${this.botName} reacted ${reaction}]`);
  }

  async stop(): Promise<void> {
    this.running = false;
  }
}
