// Turns an inbound message into a reply:
// - group mode: the first group chat the agent is used in becomes the household chat; other groups
//   are ignored. Everyone in that group becomes a household member (placeholder name until they say).
// - the first time in a group, post one intro asking each roommate's name; "I'm <name>" sets it
// - DMs are only answered for household members
// - in groups, reply only when called by name/alias, replied to, asked a question, or for a clear
//   food/expense log; otherwise stay silent and keep the message as context
// - run the agent, then send the reply (and any private DMs) through the outbox
// Logs never contain message text or full phone numbers.

import type { Database } from "bun:sqlite";
import type { Adapter, InboundMessage } from "./adapters/types";
import { runAgent, type AgentInput, type HistoryTurn } from "./agent/loop";
import { parseIntent } from "./agent/fallback";
import { makeTriggers, type Triggers } from "./agent/triggers";
import { hasPendingCook, type ToolContext } from "./agent/tools";
import { now } from "./clock";
import { localDate } from "./domain/expenses";
import {
  addParticipants,
  adoptGroupChat,
  getHousehold,
  getMembers,
  memberByPhone,
  parseNameIntro,
  setMemberName,
  type Member,
} from "./domain/household";
import { mask, normalizePhone } from "./domain/phone";
import type { Outbox } from "./outbox";
import type { Draft } from "./privacy/projection";
import { getPendingReceipt, handleReceiptReply, pendingFromCheck, receiptSummary, savePendingReceipt, parseReceiptReply } from "./receipts/flow";
import { checkReceipt, downloadImage, maybeImage, readReceipt, ReceiptError, type DownloadOptions, type RawReceipt } from "./receipts/receipt";

export const HISTORY_LIMIT = 12;

export interface RouterDeps {
  db: Database;
  outbox: Outbox;
  adapter: Adapter;
  botName: string;
  botAliases?: string[];
  model: string;
  client: AgentInput["client"];
  /** TheMealDB client for recipe ideas; omit for built-in recipes only. */
  mealdb?: ToolContext["mealdb"];
  log?: (line: string) => void;
  /** Terminal mode: a stand-in group chat id that is accepted but never saved as the household chat. */
  devGroupChatId?: string;
  /** Receipt photos: how to download (Claw key, file:// in terminal) and, for tests, a stand-in reader. */
  receipts?: DownloadOptions & { read?: (att: { url: string; mimeType?: string }) => Promise<RawReceipt> };
}

const RECEIPT_ERRORS: Record<ReceiptError["code"], string> = {
  download: "I couldn't download that photo. Could you send it again?",
  not_image: "That doesn't look like a photo. Send a picture of the receipt and I'll read it.",
  timeout: "Reading that receipt took too long. Try a clearer, closer photo, or type it like \"groceries $48.60 split 3 ways\".",
  unreadable: "I couldn't read a receipt in that photo. Try a clearer, flatter shot, or type it like \"groceries $48.60 split 3 ways\".",
  llm: "I'm having trouble reading receipts right now. You can type it like \"groceries $48.60 split 3 ways\".",
};

/** Should the agent speak in a group for this message? */
export function shouldReplyInGroup(m: InboundMessage, triggers: Triggers, repliedToBot: boolean, awaitingYes = false): boolean {
  const text = m.text.trim();
  if (!text && m.attachments.length === 0) return false;
  // A photo in the household group is a receipt to read.
  if (m.attachments.some(maybeImage)) return true;
  if (triggers.mentions(text)) return true;
  if (repliedToBot) return true;
  if (/\?\s*$/.test(text)) return true;
  const intent = parseIntent(triggers.strip(text));
  // A bare "yes" in the group only counts when we asked this person to confirm something.
  if (intent?.kind === "confirm") return awaitingYes;
  return intent !== null;
}

export function introText(botName: string, triggers: Triggers, askNames = true): string {
  const also = triggers.names.filter((n) => n.toLowerCase() !== botName.toLowerCase());
  return [
    `Hi, I'm ${botName}! I help this house split groceries, keep track of what's in the fridge, and waste less food.`,
    ...(askNames ? [`First, what should I call each of you? Reply "I'm <your name>".`] : []),
    `To get my attention, just say "${botName}"${also.length ? ` (or ${also.map((a) => `"${a}"`).join(", ")})` : ""}.`,
  ].join("\n");
}

function loadHistory(db: Database, chatId: string): HistoryTurn[] {
  return db
    .query<{ role: "user" | "assistant"; content: string }, [string, number]>(
      `SELECT role, content FROM (SELECT id, role, content FROM turns WHERE chat_id = ? AND role IN ('user','assistant')
        ORDER BY id DESC LIMIT ?) ORDER BY id`,
    )
    .all(chatId, HISTORY_LIMIT);
}

function saveTurn(db: Database, chatId: string, member: Member | null, role: "user" | "assistant", content: string, at: string) {
  db.run("INSERT INTO turns (chat_id, member_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)", [chatId, member?.id ?? null, role, content, at]);
  // Cap history per chat.
  db.run(
    `DELETE FROM turns WHERE chat_id = ? AND id NOT IN (SELECT id FROM turns WHERE chat_id = ? ORDER BY id DESC LIMIT ?)`,
    [chatId, chatId, HISTORY_LIMIT * 3],
  );
}

/** Mark a one-time event; returns true the first time only. */
function once(db: Database, key: string): boolean {
  return db.run("INSERT OR IGNORE INTO state (key, value) VALUES (?, ?)", [key, now().toISOString()]).changes > 0;
}

export function makeRouter(deps: RouterDeps) {
  const log = deps.log ?? ((l: string) => console.log(l));
  const { db } = deps;
  const triggers = makeTriggers(deps.botName, deps.botAliases ?? []);

  /** Download, read, and check a receipt photo; save it as pending and return the summary to show. */
  async function startReceipt(att: { url: string; mimeType?: string }, caption: string, rctx: Parameters<typeof handleReceiptReply>[0] & { isGroup: boolean }): Promise<string | null> {
    if (!deps.receipts?.read && !deps.client) {
      return "I can read receipt photos when the AI is on. For now, type it like \"groceries $48.60 split 3 ways\".";
    }
    let raw: RawReceipt;
    try {
      if (deps.receipts?.read) raw = await deps.receipts.read(att);
      else {
        // The bytes exist only inside this block and are dropped once Gemini has read them.
        const image = await downloadImage(att, deps.receipts ?? {});
        log(`[receipt] ${image.mime}, ${Math.round(image.bytes.byteLength / 1024)} KB`);
        raw = await readReceipt(deps.client!, deps.model, image);
      }
    } catch (error) {
      const code = error instanceof ReceiptError ? error.code : "llm";
      log(`[receipt] failed: ${code}`);
      // A video or voice memo in the group isn't meant for us: stay quiet. In a DM, say what we need.
      if (code === "not_image" && rctx.isGroup) return null;
      return RECEIPT_ERRORS[code];
    }
    const checked = checkReceipt(raw);
    log(`[receipt] ${checked.items.length} items, ${checked.balanced ? "balanced" : "does not add up"}${checked.dropped ? `, ${checked.dropped} non-item lines dropped` : ""}`);
    // Not a receipt (a meme, a selfie): stay quiet in the group; say so in a DM.
    if (checked.items.length === 0) return rctx.isGroup ? null : RECEIPT_ERRORS.unreadable;
    const pending = pendingFromCheck(checked, rctx.member.id);
    savePendingReceipt(db, pending);
    // A caption like "Sam paid" or "2 is mine" applies right away.
    if (caption && parseReceiptReply(caption, rctx.members, rctx.member.id)) {
      const updated = handleReceiptReply(rctx, caption.replace(/^(yes|ok|okay|confirm)\b[,\s]*/i, ""));
      if (updated) return updated;
    }
    return receiptSummary(pending, rctx.members);
  }

  return async function handle(m: InboundMessage): Promise<void> {
    const household = getHousehold(db);
    if (!household) {
      log("[in] no household seeded; run `bun run seed`");
      return;
    }
    const phone = normalizePhone(m.from) ?? m.from;
    const at = m.sentAt ?? now().toISOString();
    const groupReply = (text: string) => deps.outbox.send({ audience: { kind: "group" }, text, sensitivity: "household" }, { kind: "reply" });

    let added: Member[] = [];
    if (m.isGroup) {
      if (deps.devGroupChatId && m.chatId === deps.devGroupChatId) {
        // Terminal stand-in group: accepted, never adopted.
      } else if (household.mode === "group") {
        if (!household.chat_id) {
          adoptGroupChat(db, household.id, m.chatId);
          household.chat_id = m.chatId;
          log("[in] adopted this group chat as the household chat");
        } else if (household.chat_id !== m.chatId) {
          log("[in] ignored: a group chat that isn't the household chat");
          return;
        }
      }
      // Everyone in the household group is a roommate.
      const phones = [...(m.participants ?? []), phone].map((p) => normalizePhone(p)).filter((p): p is string => p !== null);
      added = addParticipants(db, household.id, phones);
      if (added.length) log(`[in] added ${added.length} roommate(s) from the group: ${added.map((a) => mask(a.phone)).join(", ")}`);
    }

    const member = memberByPhone(db, phone);
    if (!member || member.household_id !== household.id) {
      log(`[in] ignored: ${mask(phone)} is not a household member`);
      return;
    }

    const name = parseNameIntro(triggers.strip(m.text));

    // First time in this group: introduce ourselves and ask everyone's name. Later joiners get a
    // welcome, unless the only newcomer is the sender and they just told us their name.
    if (m.isGroup && once(db, `intro:${m.chatId}`)) {
      const intro = introText(deps.botName, triggers, getMembers(db, household.id).some((x) => !x.named));
      await groupReply(intro);
      saveTurn(db, m.chatId, null, "assistant", intro, at);
    } else if (m.isGroup) {
      const toWelcome = added.filter((a) => !(name && a.phone === phone));
      if (toWelcome.length) await groupReply(`Welcome, ${toWelcome.map((a) => a.name).join(" and ")}! What should I call you? Reply "I'm <your name>".`);
    }

    // "I'm Akhila" -> set the name.
    if (name) {
      setMemberName(db, member.id, name);
      const unnamed = getMembers(db, household.id).filter((x) => !x.named);
      const reply = `Nice to meet you, ${name}!${unnamed.length ? ` Still waiting on: ${unnamed.map((u) => u.name).join(", ")}.` : " That's everyone, thanks!"}`;
      log(`[in] ${m.isGroup ? "group" : "dm"} from ${mask(phone)}: name set`);
      if (m.isGroup) await groupReply(reply);
      else await deps.outbox.send({ audience: { kind: "member", memberId: member.id }, text: reply, sensitivity: "personal", subjectMemberId: member.id }, { kind: "reply" });
      saveTurn(db, m.chatId, member, "user", `${name}: ${m.text}`, at);
      return;
    }

    const members = getMembers(db, household.id);
    const shown = m.isGroup ? `${member.name}: ${m.text}` : m.text;
    const repliedToBot = !!m.replyTo && !!db.query("SELECT 1 FROM sends WHERE message_id = ?").get(m.replyTo.messageId);
    const reply = async (text: string) => {
      if (m.isGroup) await deps.outbox.send({ audience: { kind: "group" }, text, sensitivity: "household" }, { kind: "reply", replyTo: m.messageId });
      else await deps.outbox.send({ audience: { kind: "member", memberId: member.id }, text, sensitivity: "personal", subjectMemberId: member.id }, { kind: "reply" });
      saveTurn(db, m.chatId, null, "assistant", text, at);
    };
    const receiptDrafts: Draft[] = [];
    const rctx = { db, householdId: household.id, tz: household.tz, members, member, messageId: m.messageId, isGroup: m.isGroup, drafts: receiptDrafts };

    // A reply to this person's pending receipt ("yes", "Sam paid", "2 is mine", "cancel"): handled in code.
    const images = m.attachments.filter(maybeImage);
    const receiptReply = images.length ? null : handleReceiptReply(rctx, triggers.strip(m.text));
    if (receiptReply) {
      saveTurn(db, m.chatId, member, "user", shown, at);
      log(`[in] ${m.isGroup ? "group" : "dm"} from ${mask(phone)}: receipt reply`);
      await reply(receiptReply);
      for (const d of receiptDrafts) await deps.outbox.send(d, { kind: "reply" });
      return;
    }

    if (m.isGroup && !shouldReplyInGroup(m, triggers, repliedToBot, hasPendingCook(db, member.id))) {
      saveTurn(db, m.chatId, member, "user", shown, at);
      log(`[in] group from ${mask(phone)}: context only`);
      return;
    }
    log(`[in] ${m.isGroup ? "group" : "dm"} from ${mask(phone)}${m.attachments.length ? ` (${m.attachments.length} attachment)` : ""}`);

    if (images.length) {
      saveTurn(db, m.chatId, member, "user", `${shown} [sent a photo]`, at);
      await deps.adapter.typing?.(m.isGroup ? { kind: "group", chatId: m.chatId } : { kind: "member", phone }, true).catch(() => {});
      const text = await startReceipt(images[0]!, triggers.strip(m.text), rctx);
      if (text) await reply(text);
      return;
    }

    const drafts: Draft[] = [];
    const ctx: ToolContext = {
      db, household, members, member, isGroup: m.isGroup, messageId: m.messageId, chatId: m.chatId, sentAt: m.sentAt, drafts,
      mealdb: deps.mealdb ?? null,
      text: m.text,
    };
    const history = loadHistory(db, m.chatId);
    saveTurn(db, m.chatId, member, "user", shown, at);

    const destination = m.isGroup ? ({ kind: "group", chatId: m.chatId } as const) : ({ kind: "member", phone } as const);
    await deps.adapter.typing?.(destination, true).catch(() => {});
    const result = await runAgent({
      text: triggers.strip(m.text) || m.text,
      ctx,
      history,
      botName: deps.botName,
      model: deps.model,
      localDate: localDate(household.tz),
      client: deps.client,
    });
    await deps.adapter.typing?.(destination, false).catch(() => {});
    log(`[agent] ${result.source}${result.toolCalls.length ? ` tools=${result.toolCalls.join(",")}` : ""}${result.note ? ` (${result.note})` : ""}`);

    if (result.reply) {
      const draft: Draft = m.isGroup
        ? { audience: { kind: "group" }, text: result.reply, sensitivity: "household" }
        : { audience: { kind: "member", memberId: member.id }, text: result.reply, sensitivity: "personal", subjectMemberId: member.id };
      await deps.outbox.send(draft, { kind: "reply", replyTo: m.isGroup ? m.messageId : undefined });
      saveTurn(db, m.chatId, null, "assistant", result.reply, at);
    } else if (m.isGroup) {
      await deps.adapter.react?.(m.messageId, "like").catch(() => {});
    }
    for (const d of drafts) await deps.outbox.send(d, { kind: "reply" });
  };
}
