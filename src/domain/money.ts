// Money is always integer cents. Parsing and formatting live here; no floats are stored.

/** Parse "$48.60", "48.6", "48", "$1,204.50", "9 dollars" into cents. Null if not a money amount. */
export function parseCents(raw: string | number): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.round(raw * 100);
  }
  const m = raw.replace(/,/g, "").match(/\$?\s*(\d+)(?:\.(\d{1,2}))?/);
  if (!m) return null;
  const dollars = Number(m[1]);
  const cents = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  return dollars * 100 + cents;
}

/** 4860 -> "$48.60", -1320 -> "-$13.20" */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
