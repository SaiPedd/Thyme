// Household and member lookups. One household. Its members come from the household group chat's
// participants (or the seed); each starts with a placeholder name until they tell us theirs.

import type { Database } from "bun:sqlite";
import { now } from "../clock";

export interface Household {
  id: number;
  name: string;
  chat_id: string | null;
  tz: string;
  mode: "group" | "dm";
}

export interface Member {
  id: number;
  household_id: number;
  phone: string;
  name: string;
  /** 0 until the member told us their name. */
  named?: number;
}

export function getHousehold(db: Database): Household | null {
  return db.query<Household, []>("SELECT id, name, chat_id, tz, mode FROM households ORDER BY id LIMIT 1").get();
}

export function getMembers(db: Database, householdId: number): Member[] {
  return db
    .query<Member, [number]>("SELECT id, household_id, phone, name, named FROM members WHERE household_id = ? ORDER BY id")
    .all(householdId);
}

export function memberByPhone(db: Database, phone: string): Member | null {
  return db.query<Member, [string]>("SELECT id, household_id, phone, name, named FROM members WHERE phone = ?").get(phone);
}

/** Find a member by (case-insensitive) first name, for "split with Sam". */
export function memberByName(members: Member[], name: string): Member | undefined {
  const n = name.trim().toLowerCase();
  return members.find((m) => m.name.toLowerCase() === n) ?? members.find((m) => m.name.toLowerCase().startsWith(n));
}

/** In group mode, the first group chat the agent is used in becomes the household's chat. */
export function adoptGroupChat(db: Database, householdId: number, chatId: string): void {
  db.run("UPDATE households SET chat_id = ? WHERE id = ? AND chat_id IS NULL", [chatId, householdId]);
}

/** Placeholder until someone tells us their name. Shows only the last 4 digits. */
export function placeholderName(phone: string): string {
  return `Roommate ${phone.slice(-4)}`;
}

/** Add any group participants who aren't members yet. Returns the newly added members. */
export function addParticipants(db: Database, householdId: number, phones: string[]): Member[] {
  const added: Member[] = [];
  for (const phone of new Set(phones)) {
    const existing = memberByPhone(db, phone);
    if (existing) continue;
    const row = db
      .query<{ id: number }, [number, string, string, string]>(
        "INSERT INTO members (household_id, phone, name, named, created_at) VALUES (?, ?, ?, 0, ?) RETURNING id",
      )
      .get(householdId, phone, placeholderName(phone), now().toISOString())!;
    added.push({ id: row.id, household_id: householdId, phone, name: placeholderName(phone), named: 0 });
  }
  return added;
}

export function setMemberName(db: Database, memberId: number, name: string): void {
  db.run("UPDATE members SET name = ?, named = 1 WHERE id = ?", [name, memberId]);
}

const NOT_NAMES = new Set(["here", "in", "out", "back", "home", "done", "good", "fine", "ok", "okay", "hungry", "sorry", "not", "so", "just", "going", "at", "on"]);

/**
 * "I'm Akhila", "my name is Sam", "call me J", "it's Jordan" -> the name, title-cased. Null otherwise.
 * Only a single short word, so "I'm out of milk" or "I'm going to the store" aren't names.
 */
export function parseNameIntro(text: string): string | null {
  const m = text.trim().match(/^(?:hi[,!]?\s+|hey[,!]?\s+)?(?:i'?m|i am|im|my name is|my name's|call me|it'?s|this is)\s+([a-z][a-z'-]{0,19})[\s.!]*$/i);
  if (!m) return null;
  const word = m[1]!;
  if (NOT_NAMES.has(word.toLowerCase())) return null;
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}
