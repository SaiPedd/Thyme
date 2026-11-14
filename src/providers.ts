// Provider selection and handle helpers. Pure functions, no Spectrum imports, so they are easy to test.

export const PROVIDER_NAMES = ["terminal", "imessage"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Parse PROVIDERS ("terminal,imessage"). Defaults to terminal. Throws on unknown names. */
export function parseProviders(raw: string | undefined): ProviderName[] {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return ["terminal"];
  const result: ProviderName[] = [];
  for (const name of names) {
    if (!(PROVIDER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`PROVIDERS: unknown provider "${name}". Valid: ${PROVIDER_NAMES.join(", ")}`);
    }
    if (!result.includes(name as ProviderName)) result.push(name as ProviderName);
  }
  return result;
}

/** Phone numbers to +E.164 (US default), emails lowercased, so allowlist and senders match. */
export function normalizeHandle(raw: string): string {
  const value = raw.trim();
  if (value.includes("@")) return value.toLowerCase();
  const digits = value.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits;
}

/** Last 4 characters only, for logs. */
export function mask(id: string): string {
  return `…${id.slice(-4)}`;
}
