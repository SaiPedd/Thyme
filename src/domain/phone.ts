// Phone helpers. Claw Messenger only accepts phone numbers in +E.164 form (no emails).

/** Normalize a phone number to +E.164 (US default). Returns null if it can't be a valid number. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.trim().replace(/[^\d+]/g, "");
  let e164: string;
  if (digits.startsWith("+")) e164 = digits;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

/** Last 4 characters only, for logs. Never log a full number. */
export function mask(id: string | null | undefined): string {
  if (!id) return "…????";
  return `…${id.slice(-4)}`;
}
