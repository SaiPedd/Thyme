// Per-person food preferences (diet, dislikes, allergies, likes) and the checks recipes run against them.
// Preferences are personal: never shown in the group, and allergies are never tied to a name there.

import type { Database } from "bun:sqlite";
import { now } from "../clock";
import { nameWords } from "./inventory";

export type PrefKind = "diet" | "dislike" | "allergy" | "like";

export interface Pref {
  member_id: number;
  kind: PrefKind;
  value: string;
}

/** Diets we can check in code. Others are saved but not enforced (and we say so). */
export const KNOWN_DIETS = ["vegetarian", "vegan", "pescatarian", "gluten-free", "dairy-free"] as const;

const TAGS: Record<string, string[]> = {
  meat: ["chicken", "beef", "pork", "bacon", "ham", "sausage", "turkey", "steak", "lamb", "pepperoni", "salami", "prosciutto"],
  fish: ["salmon", "tuna", "shrimp", "fish", "cod", "tilapia", "crab", "lobster", "anchovy", "sardine"],
  shellfish: ["shrimp", "crab", "lobster", "clam", "mussel", "oyster", "scallop"],
  dairy: ["milk", "cheese", "butter", "yogurt", "cream", "parmesan", "mozzarella", "cheddar"],
  egg: ["egg"],
  gluten: ["bread", "pasta", "flour", "tortilla", "bagel", "cereal", "cracker", "noodle"],
  nuts: ["peanut", "almond", "walnut", "cashew", "pecan", "pistachio", "hazelnut"],
};

const PLANT = ["peanut", "almond", "oat", "soy", "coconut", "cashew", "vegan"];

const DIET_EXCLUDES: Record<string, string[]> = {
  vegetarian: ["meat", "fish"],
  vegan: ["meat", "fish", "dairy", "egg"],
  pescatarian: ["meat"],
  "gluten-free": ["gluten"],
  "dairy-free": ["dairy"],
};

/** Allergy words that mean a whole tag ("lactose" -> dairy). */
const ALLERGY_TAGS: Record<string, string> = {
  dairy: "dairy", lactose: "dairy", milk: "dairy", egg: "egg", gluten: "gluten", wheat: "gluten", celiac: "gluten",
  shellfish: "shellfish", fish: "fish", nut: "nuts", "tree nut": "nuts", peanut: "nuts",
};

export function normalizeDiet(v: string): string {
  const s = v.toLowerCase().replace(/[^a-z ]/g, " ").trim().replace(/\s+/g, "-");
  if (/^veg(e|gie)?tarian$/.test(s)) return "vegetarian";
  if (/^(no|without)-gluten$|^gluten-free$|^celiac$/.test(s)) return "gluten-free";
  if (/^(no|without)-dairy$|^dairy-free$|^lactose-(free|intolerant)$/.test(s)) return "dairy-free";
  return s;
}

export function tagsOf(ingredient: string): Set<string> {
  const words = nameWords(ingredient);
  const tags = new Set<string>();
  for (const [tag, list] of Object.entries(TAGS)) if (words.some((w) => list.includes(w))) tags.add(tag);
  // Plant "milk"/"butter"/"cheese" aren't dairy.
  if (words.some((w) => PLANT.includes(w))) tags.delete("dairy");
  return tags;
}

/** Why an ingredient doesn't fit a preference, or null if it fits. */
export function conflict(ingredient: string, pref: Pick<Pref, "kind" | "value">): string | null {
  const words = nameWords(ingredient);
  const tags = tagsOf(ingredient);
  if (pref.kind === "diet") {
    const excluded = DIET_EXCLUDES[pref.value] ?? [];
    return excluded.some((t) => tags.has(t)) ? `not ${pref.value}` : null;
  }
  if (pref.kind === "dislike" || pref.kind === "allergy") {
    const v = nameWords(pref.value);
    const direct = v.length > 0 && v.every((w) => words.includes(w));
    const viaTag = pref.kind === "allergy" && (ALLERGY_TAGS[v.join(" ")] ?? ALLERGY_TAGS[v.at(-1) ?? ""]);
    if (direct || (viaTag && tags.has(viaTag))) return pref.kind === "allergy" ? "allergy" : "disliked";
  }
  return null;
}

export function savePref(db: Database, memberId: number, kind: PrefKind, value: string): { saved: boolean; value: string } {
  const v = kind === "diet" ? normalizeDiet(value) : value.toLowerCase().replace(/[.!?]+$/, "").trim();
  const r = db.run("INSERT OR IGNORE INTO prefs (member_id, kind, value, created_at) VALUES (?, ?, ?, ?)", [memberId, kind, v, now().toISOString()]);
  return { saved: r.changes > 0, value: v };
}

export function removePref(db: Database, memberId: number, kind: PrefKind, value: string): boolean {
  const v = kind === "diet" ? normalizeDiet(value) : value.toLowerCase().trim();
  return db.run("DELETE FROM prefs WHERE member_id = ? AND kind = ? AND value = ?", [memberId, kind, v]).changes > 0;
}

export function prefsFor(db: Database, memberIds: number[]): Pref[] {
  if (memberIds.length === 0) return [];
  return db
    .query<Pref, number[]>(`SELECT member_id, kind, value FROM prefs WHERE member_id IN (${memberIds.map(() => "?").join(",")}) ORDER BY id`)
    .all(...memberIds);
}

/** "Forget me": delete a member's preferences, pending recipe state, and conversation turns. Money records stay. */
export function forgetMember(db: Database, memberId: number, dmChatId?: string): { prefs: number; turns: number } {
  return db.transaction(() => {
    const prefs = db.run("DELETE FROM prefs WHERE member_id = ?", [memberId]).changes;
    let turns = db.run("DELETE FROM turns WHERE member_id = ?", [memberId]).changes;
    if (dmChatId) turns += db.run("DELETE FROM turns WHERE chat_id = ?", [dmChatId]).changes;
    db.run("DELETE FROM state WHERE key IN (?, ?)", [`recipe:${memberId}`, `cook:${memberId}`]);
    return { prefs, turns };
  })();
}
