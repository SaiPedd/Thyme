import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { makeTriggers } from "../src/agent/triggers";
import { parseNameIntro } from "../src/domain/household";
import { Inbox } from "../src/inbox";
import { Outbox } from "../src/outbox";
import { makeRouter, shouldReplyInGroup } from "../src/router";
import { FakeAdapter, PHONES, quietLog, setupHousehold } from "./helpers";

function app(opts: { chatId?: string | null; members?: boolean; introDone?: boolean; aliases?: string[] } = {}) {
  const db = setupHousehold({ chatId: opts.chatId });
  if (opts.members === false) db.run("DELETE FROM members");
  // Most tests skip the one-time intro so message counts stay simple.
  if (opts.introDone !== false) db.run("INSERT INTO state (key, value) VALUES ('intro:chat-1', 't')");
  const adapter = new FakeAdapter();
  const outbox = new Outbox(db, adapter, { sleep: async () => {}, log: quietLog });
  // client: null -> rule-based fallback, so these tests are deterministic and offline.
  const router = makeRouter({ db, outbox, adapter, botName: "Thyme", botAliases: opts.aliases, model: "x", client: null, log: quietLog });
  const inbox = new Inbox(db, router, { debounceMs: 5 });
  adapter.start({ onMessage: (m) => inbox.push(m) });
  return { db, adapter, inbox };
}

const msg = (from: string, text: string, extra: Record<string, unknown> = {}) => ({
  messageId: crypto.randomUUID(),
  chatId: "chat-1",
  from,
  text,
  attachments: [],
  isGroup: true,
  ...extra,
});

const names = (db: Database) => db.query<{ name: string; named: number }, []>("SELECT name, named FROM members ORDER BY id").all();

describe("triggers", () => {
  const t = makeTriggers("Thyme", ["thymey"]);
  test("name or alias anywhere, any case, with @ or hey", () => {
    for (const s of ["Thyme what do I owe", "hey thyme, split this", "@Thyme help", "ok THYMEY", "what's for dinner thyme?"]) {
      expect(t.mentions(s)).toBe(true);
    }
    expect(t.mentions("thymeless")).toBe(false);
    expect(t.mentions("see you at 8")).toBe(false);
  });
  test("strip removes a leading call", () => {
    expect(t.strip("hey Thyme, groceries were $30 split 3 ways")).toBe("groceries were $30 split 3 ways");
    expect(t.strip("@thymey: undo")).toBe("undo");
  });
  test("reply rules use the triggers", () => {
    const m = (text: string) => msg(PHONES[0]!, text) as any;
    expect(shouldReplyInGroup(m("thyme hi"), t, false)).toBe(true);
    expect(shouldReplyInGroup(m("anyone home?"), t, false)).toBe(true);
    expect(shouldReplyInGroup(m("got eggs and milk"), t, false)).toBe(true);
    expect(shouldReplyInGroup(m("lol ok"), t, false)).toBe(false);
    expect(shouldReplyInGroup(m("lol ok"), t, true)).toBe(true);
  });
});

describe("names", () => {
  test("parseNameIntro", () => {
    expect(parseNameIntro("I'm akhila")).toBe("Akhila");
    expect(parseNameIntro("hi, my name is Sam!")).toBe("Sam");
    expect(parseNameIntro("call me J")).toBe("J");
    expect(parseNameIntro("I'm out of milk")).toBeNull();
    expect(parseNameIntro("I'm home")).toBeNull();
    expect(parseNameIntro("groceries were $30")).toBeNull();
  });

  test("joining a group: roommates come from participants, one intro, names set by reply", async () => {
    const { db, adapter, inbox } = app({ chatId: null, members: false, introDone: false });
    inbox.push(msg(PHONES[0]!, "hey everyone", { chatId: "real-group", participants: [PHONES[0], PHONES[1]] }));
    await inbox.drain();
    expect(names(db)).toEqual([
      { name: "Roommate 0101", named: 0 },
      { name: "Roommate 0102", named: 0 },
    ]);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.text).toContain(`Hi, I'm Thyme!`);
    expect(adapter.sent[0]!.text).toContain(`Reply "I'm <your name>"`);

    adapter.sent = [];
    inbox.push(msg(PHONES[0]!, "I'm Akhila", { chatId: "real-group", participants: [PHONES[0], PHONES[1]] }));
    await inbox.drain();
    expect(adapter.sent.map((s) => s.text)).toEqual(["Nice to meet you, Akhila! Still waiting on: Roommate 0102."]);
    inbox.push(msg(PHONES[1]!, "im sam", { chatId: "real-group", participants: [PHONES[0], PHONES[1]] }));
    await inbox.drain();
    expect(adapter.sent.at(-1)!.text).toBe("Nice to meet you, Sam! That's everyone, thanks!");
    expect(names(db).map((n) => n.name)).toEqual(["Akhila", "Sam"]);
  });

  test("a roommate added later gets a welcome", async () => {
    const { adapter, inbox } = app();
    inbox.push(msg(PHONES[0]!, "lol", { participants: [PHONES[0], PHONES[1], PHONES[2], "+16095550104"] }));
    await inbox.drain();
    expect(adapter.sent.map((s) => s.text)).toEqual([`Welcome, Roommate 0104! What should I call you? Reply "I'm <your name>".`]);
  });
});

describe("router end to end (fallback agent)", () => {
  test("group expense: split posted to the group; chatter stays silent", async () => {
    const { adapter, inbox, db } = app();
    inbox.push(msg(PHONES[0]!, "groceries were $48.60, split 3 ways, chicken thighs ($9) are just mine"));
    inbox.push(msg(PHONES[1]!, "nice"));
    await inbox.drain();
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.destination).toEqual({ kind: "group", chatId: "chat-1" });
    expect(adapter.sent[0]!.text).toContain("Sam owes Alex $13.20");
    expect(adapter.sent[0]!.text).toContain("Jordan owes Alex $13.20");
    expect(adapter.sent[0]!.text).toContain("Alex's own share is $22.20");
    const turns = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM turns WHERE role = 'user'").get()!.n;
    expect(turns).toBe(2);
  });

  test("calling the agent by name or alias works anywhere in the message", async () => {
    const { adapter, inbox } = app({ aliases: ["thymey"] });
    inbox.push(msg(PHONES[0]!, "hey Thyme, groceries were $30 split 3 ways"));
    await inbox.drain();
    expect(adapter.sent.at(-1)!.text).toContain("Logged $30.00");
    inbox.push(msg(PHONES[0]!, "ok thymey undo"));
    await inbox.drain();
    expect(adapter.sent.at(-1)!.text).toBe("Undone: the $30.00 expense is removed.");
  });

  test("'what do I owe?' in the group: balance goes only to the asker's DM", async () => {
    const { adapter, inbox } = app();
    inbox.push(msg(PHONES[0]!, "groceries were $30 split 3 ways"));
    await inbox.drain();
    adapter.sent = [];
    inbox.push(msg(PHONES[1]!, "what do I owe?"));
    await inbox.drain();
    const group = adapter.sent.filter((s) => s.destination.kind === "group");
    const dms = adapter.sent.filter((s) => s.destination.kind === "member");
    expect(group).toHaveLength(1);
    expect(group[0]!.text).not.toMatch(/\$\d/);
    expect(dms).toHaveLength(1);
    expect(dms[0]!.destination).toEqual({ kind: "member", phone: PHONES[1]! });
    expect(dms[0]!.text).toContain("you owe $10.00");
  });

  test("DM gets the numbers directly", async () => {
    const { adapter, inbox } = app();
    inbox.push(msg(PHONES[0]!, "groceries were $30 split 3 ways"));
    await inbox.drain();
    adapter.sent = [];
    inbox.push(msg(PHONES[0]!, "what do I owe?", { isGroup: false, chatId: "dm-1" }));
    await inbox.drain();
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.destination).toEqual({ kind: "member", phone: PHONES[0]! });
    expect(adapter.sent[0]!.text).toContain("you are owed $20.00");
  });

  test("DMs from non-members and messages in other group chats are ignored", async () => {
    const { adapter, inbox, db } = app();
    inbox.push(msg("+16095559999", "undo", { isGroup: false, chatId: "dm-x" }));
    inbox.push(msg("+16095559999", "Thyme, what do I owe?", { chatId: "some-other-group" }));
    await inbox.drain();
    expect(adapter.sent).toHaveLength(0);
    expect(db.query("SELECT 1 FROM members WHERE phone = '+16095559999'").get()).toBeNull();
  });

  test("duplicate messageIds are processed once", async () => {
    const { adapter, inbox } = app();
    const m = msg(PHONES[0]!, "groceries were $12 split 3 ways");
    expect(inbox.push(m)).toBe(true);
    expect(inbox.push({ ...m })).toBe(false);
    await inbox.drain();
    expect(adapter.sent).toHaveLength(1);
  });

  test("the first group the agent is used in is adopted as the household chat", async () => {
    const { db, inbox } = app({ chatId: null });
    inbox.push(msg(PHONES[2]!, "hey Thyme", { chatId: "real-group" }));
    await inbox.drain();
    expect(db.query<{ chat_id: string }, []>("SELECT chat_id FROM households").get()!.chat_id).toBe("real-group");
  });

  test("rapid messages from one sender are merged into one turn", async () => {
    const { adapter, inbox } = app();
    inbox.push(msg(PHONES[0]!, "groceries were $30"));
    inbox.push(msg(PHONES[0]!, "split 3 ways"));
    await inbox.drain();
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.text).toContain("Logged $30.00");
  });
});
