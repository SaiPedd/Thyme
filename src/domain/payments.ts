// How each roommate wants to be paid back ("pay me through Zelle at dharaniDevadiga", "my Venmo is @dharani").
// Shown next to what someone owes them, which only ever goes to a DM. Stored in the state table
// (key "pay:<memberId>"), so no migration is needed. Handles are saved exactly as the person typed them;
// the model never makes one up (see handleIsInMessage).

import type { Database } from "bun:sqlite";

export interface PaymentMethod {
  /** Display label, e.g. "Zelle". */
  method: string;
  handle: string;
}

/** Known apps: lowercase spelling (spaces removed) -> display label. */
const METHODS: Record<string, string> = {
  zelle: "Zelle",
  venmo: "Venmo",
  cashapp: "Cash App",
  paypal: "PayPal",
  applecash: "Apple Cash",
  applepay: "Apple Cash",
};

/** "cash app", "CashApp", "venmo" -> "Cash App", "Venmo". Null if it isn't a payment app we know. */
export function normalizeMethod(raw: string): string | null {
  return METHODS[raw.toLowerCase().replace(/[^a-z]/g, "")] ?? null;
}

/** Trim quotes and trailing punctuation; null if empty, too long, or has spaces. */
export function cleanHandle(raw: string): string | null {
  const h = raw.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/[.,!?;:]+$/, "");
  return h && h.length <= 60 && !/\s/.test(h) ? h : null;
}

/** True if the handle appears in what the person actually wrote (ignoring a leading @ or $ and case). */
export function handleIsInMessage(handle: string, message: string): boolean {
  const bare = (s: string) => s.toLowerCase().replace(/^[@$]/, "");
  return message.toLowerCase().includes(bare(handle));
}

const key = (memberId: number) => `pay:${memberId}`;

export function paymentMethods(db: Database, memberId: number): PaymentMethod[] {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key(memberId));
  return row ? (JSON.parse(row.value) as PaymentMethod[]) : [];
}

function store(db: Database, memberId: number, methods: PaymentMethod[]): void {
  if (methods.length === 0) db.run("DELETE FROM state WHERE key = ?", [key(memberId)]);
  else db.run("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key(memberId), JSON.stringify(methods)]);
}

/** Save (or replace) one app's handle. Several apps per person are kept. */
export function savePaymentMethod(db: Database, memberId: number, method: string, handle: string): PaymentMethod[] {
  const methods = paymentMethods(db, memberId).filter((m) => m.method !== method);
  methods.push({ method, handle });
  store(db, memberId, methods);
  return methods;
}

export function removePaymentMethod(db: Database, memberId: number, method: string): boolean {
  const before = paymentMethods(db, memberId);
  const after = before.filter((m) => m.method !== method);
  store(db, memberId, after);
  return after.length < before.length;
}

/** "Zelle: dharaniDevadiga, Venmo: @dharani", or "" if none saved. */
export function describePaymentMethods(methods: PaymentMethod[]): string {
  return methods.map((m) => `${m.method}: ${m.handle}`).join(", ");
}

/** Delete one member's payment info ("forget me"). */
export function forgetPaymentMethods(db: Database, memberId: number): void {
  store(db, memberId, []);
}
