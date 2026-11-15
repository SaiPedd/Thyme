// Receipt photos: download, read with Gemini (vision), validate with Zod, and check the math in code.
// The model only transcribes what is printed; every amount is parsed and checked here.
// Image bytes live only inside downloadImage/readReceipt and are never stored or logged. Neither is the URL.
// Card numbers never reach storage: payment lines are dropped and 4+ digit runs are removed from names.

import { z } from "zod";
import type { GeminiLike } from "../agent/loop";
import { parseCents } from "../domain/money";

export const RECEIPT_TIMEOUT_MS = 20_000;

export class ReceiptError extends Error {
  constructor(
    readonly code: "download" | "not_image" | "timeout" | "unreadable" | "llm",
    message: string = code,
  ) {
    super(message);
  }
}

// ---- Download (bytes stay in memory) ----

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", webp: "image/webp", gif: "image/gif",
};

export function guessMime(declared: string | undefined, served: string | null, url: string): string | null {
  for (const m of [declared, served]) if (m && m.toLowerCase().startsWith("image/")) return m.toLowerCase().split(";")[0]!.trim();
  const ext = url.split("?")[0]!.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? null;
}

/** Could this attachment be a photo? Unknown mime counts (Claw may omit it). */
export function maybeImage(a: { url: string; mimeType?: string }): boolean {
  if (a.mimeType) return a.mimeType.toLowerCase().startsWith("image/");
  return guessMime(undefined, null, a.url) !== null || !/\.[a-z0-9]{2,4}(\?|$)/i.test(a.url);
}

export interface DownloadOptions {
  /** Claw API key, sent as a Bearer token only if the plain download is refused. */
  apiKey?: string;
  /** Allow file:// URLs (terminal adapter only). */
  allowFile?: boolean;
  fetchImpl?: typeof fetch;
}

export async function downloadImage(att: { url: string; mimeType?: string }, opts: DownloadOptions = {}): Promise<{ bytes: Uint8Array; mime: string }> {
  if (att.url.startsWith("file://")) {
    if (!opts.allowFile) throw new ReceiptError("download", "file attachments are dev-only");
    const file = Bun.file(decodeURIComponent(att.url.slice("file://".length)));
    if (!(await file.exists())) throw new ReceiptError("download", "no such file");
    const mime = guessMime(att.mimeType, file.type, att.url);
    if (!mime) throw new ReceiptError("not_image");
    return { bytes: new Uint8Array(await file.arrayBuffer()), mime };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response | null = null;
  for (const auth of [false, true]) {
    if (auth && !opts.apiKey) break;
    try {
      res = await doFetch(att.url, auth ? { headers: { Authorization: `Bearer ${opts.apiKey}` } } : undefined);
    } catch {
      throw new ReceiptError("download");
    }
    if (res.ok || ![401, 403].includes(res.status)) break;
  }
  if (!res?.ok) throw new ReceiptError("download");
  const mime = guessMime(att.mimeType, res.headers.get("content-type"), att.url);
  if (!mime) throw new ReceiptError("not_image");
  // No size limit: phone photos are a few MB and only live in memory until Gemini has read them.
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime };
}

// ---- Reading (Gemini) and validation (Zod) ----

export const ReceiptSchema = z.object({
  store: z.string().nullish(),
  date: z.string().nullish(),
  // price may be "" and readable false for a blurry line: never a guessed number.
  items: z.array(z.object({ name: z.string(), price: z.string(), readable: z.boolean().nullish() })).min(1),
  discounts: z.string().nullish(),
  tax: z.string().nullish(),
  total: z.string().min(1),
  unreadable_lines: z.number().int().min(0).nullish(),
});
export type RawReceipt = z.infer<typeof ReceiptSchema>;

/** The same shape for Gemini's structured output (a JSON Schema subset). */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    store: { type: "string" },
    date: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, price: { type: "string" }, readable: { type: "boolean" } },
        required: ["name", "price", "readable"],
      },
    },
    discounts: { type: "string" },
    tax: { type: "string" },
    total: { type: "string" },
    unreadable_lines: { type: "integer" },
  },
  required: ["items", "total"],
};

const PROMPT = `Transcribe this grocery receipt as JSON. Copy text and amounts exactly as printed; do not compute anything.
- store: the store's name only (e.g. "Trader Joe's"), no address or store number.
- items: one entry per purchased line, with a short plain product name (expand abbreviations like "ORG BNNA" to "organic bananas") and its line price as printed, e.g. "3.99". A discount or coupon line is a negative price like "-1.00".
- discounts: the total savings line if printed, else omit. tax: the tax line, else omit. total: the final total charged.
- Never guess a price. If any digit of a line's price is blurry, cut off, or covered, still list the line, with price "" and readable false. Otherwise readable is true.
- unreadable_lines: how many item lines you could not read.
- Never include payment details: no card type, card numbers, auth codes, cash or change lines.
If the image is not a receipt, return {"items": [], "total": "0"}.`;

/** Pull a JSON object out of a model reply (tolerates code fences or extra words). */
export function extractJson(text: string): unknown {
  const s = text.replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ReceiptError("unreadable");
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    throw new ReceiptError("unreadable");
  }
}

export function parseReceiptJson(text: string): RawReceipt {
  const r = ReceiptSchema.safeParse(extractJson(text));
  if (!r.success) throw new ReceiptError("unreadable");
  return r.data;
}

export async function readReceipt(
  client: GeminiLike,
  model: string,
  image: { bytes: Uint8Array; mime: string },
  timeoutMs = RECEIPT_TIMEOUT_MS,
): Promise<RawReceipt> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  let interaction;
  try {
    interaction = await Promise.race([
      client.interactions.create(
        {
          model,
          store: false,
          input: [
            {
              type: "user_input",
              content: [
                { type: "text", text: PROMPT },
                { type: "image", data: Buffer.from(image.bytes).toString("base64"), mime_type: image.mime },
              ],
            },
          ],
          response_format: { type: "text", mime_type: "application/json", schema: RESPONSE_SCHEMA },
          generation_config: { thinking_level: "low" },
        },
        { timeout_ms: timeoutMs, signal: abort.signal, maxRetries: 0 },
      ),
      deadline,
    ]).finally(() => clearTimeout(timer));
  } catch {
    throw new ReceiptError("llm");
  }
  if (interaction === "timeout") throw new ReceiptError("timeout");
  return parseReceiptJson(interaction.output_text ?? "");
}

// ---- Checking (code owns the math) ----

export interface ReceiptLine {
  name: string;
  cents: number;
  /** One blurry line whose price was worked out from the total (total - tax + discounts - other lines). */
  inferred?: boolean;
  /** Several blurry lines lumped into one shared "other groceries" line: how many. */
  unclear?: number;
  /** The user told us what a blurry line was. */
  named?: boolean;
  /** Who this line is for: one person (theirs), a few (shared by them), or null (the whole split). */
  owners: number[] | null;
}

export interface CheckedReceipt {
  store: string | null;
  items: ReceiptLine[];
  itemsCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  /** items - discounts + tax, minus the printed total. */
  diffCents: number;
  balanced: boolean;
  unreadable: number;
  /** Lines dropped as payment info or totals. */
  dropped: number;
}

/** More blurry lines than this and the total can't sensibly fill the gap: ask for a clearer photo. */
export const MAX_FILLED_LINES = 3;

const NOT_AN_ITEM = /\b(visa|master\s?card|amex|american express|discover|debit|credit|card|acct|account|auth|approval|change|cash|tender|balance|sub\s?total|total|tax|payment|chip|contactless)\b/i;

/** Remove anything that could be a card or account number (and PLU/UPC codes). */
export function cleanName(name: string): string {
  return name.replace(/[*xX#]{2,}\d*/g, " ").replace(/#\s*\d+/g, " ").replace(/\d{4,}/g, " ").replace(/\s+/g, " ").trim();
}

const isNegative = (s: string) => /^\s*-|-\s*$|\(\s*\$?\d/.test(s);

export function checkReceipt(raw: RawReceipt): CheckedReceipt {
  const items: ReceiptLine[] = [];
  let discountCents = raw.discounts ? (parseCents(raw.discounts) ?? 0) : 0;
  const printedDiscounts = discountCents > 0;
  let dropped = 0;
  /** Blurry lines, with where they sat in the list so a filled-in line keeps its place. */
  const blurry: { name: string; at: number }[] = [];
  for (const line of raw.items) {
    if (NOT_AN_ITEM.test(line.name)) {
      dropped++;
      continue;
    }
    if (line.readable === false || !line.price.trim()) {
      blurry.push({ name: cleanName(line.name), at: items.length });
      continue;
    }
    const cents = parseCents(line.price);
    if (cents === null || cents === 0 || NOT_AN_ITEM.test(line.name)) {
      dropped++;
      continue;
    }
    if (isNegative(line.price)) {
      // A coupon line. If the receipt also printed a savings total, that total already counts it.
      if (!printedDiscounts) discountCents += cents;
      continue;
    }
    const name = cleanName(line.name);
    if (!name) {
      dropped++;
      continue;
    }
    items.push({ name, cents, owners: null });
  }
  const taxCents = raw.tax ? (parseCents(raw.tax) ?? 0) : 0;
  const totalCents = parseCents(raw.total) ?? 0;
  let unreadable = Math.max(raw.unreadable_lines ?? 0, blurry.length);

  // Blurry lines: the total is usually the clearest thing on a receipt, so let it fill the gap.
  const missing = totalCents - taxCents + discountCents - items.reduce((s, i) => s + i.cents, 0);
  if (totalCents > 0 && missing > 0 && unreadable >= 1 && unreadable <= MAX_FILLED_LINES) {
    if (unreadable === 1) {
      items.splice(blurry[0]?.at ?? items.length, 0, { name: blurry[0]?.name || "unreadable item", cents: missing, owners: null, inferred: true });
    }
    else items.push({ name: "other groceries", cents: missing, owners: null, unclear: unreadable });
    unreadable = 0;
  }

  const itemsCents = items.reduce((s, i) => s + i.cents, 0);
  const diffCents = itemsCents - discountCents + taxCents - totalCents;
  return {
    store: raw.store ? cleanName(raw.store) || null : null,
    items,
    itemsCents,
    discountCents,
    taxCents,
    totalCents,
    diffCents,
    balanced: totalCents > 0 && Math.abs(diffCents) <= 1,
    unreadable,
    dropped,
  };
}

/**
 * Allocations for items that belong to specific people: each item's price plus its proportional share
 * of (total - item subtotal), i.e. tax minus discounts, rounded down, grouped by who it's for.
 * Everything left over is split by computeSplit, which guarantees the shares sum to the total.
 */
export function allocate(items: ReceiptLine[], totalCents: number): { amountCents: number; memberIds: number[] }[] {
  const itemsCents = items.reduce((s, i) => s + i.cents, 0);
  if (itemsCents <= 0) return [];
  const adjust = totalCents - itemsCents;
  const byOwners = new Map<string, { amountCents: number; memberIds: number[] }>();
  for (const i of items) {
    if (!i.owners?.length) continue;
    const ids = [...new Set(i.owners)].sort((a, b) => a - b);
    const k = ids.join(",");
    const share = Math.max(0, i.cents + Math.floor((adjust * i.cents) / itemsCents));
    const cur = byOwners.get(k) ?? { amountCents: 0, memberIds: ids };
    cur.amountCents += share;
    byOwners.set(k, cur);
  }
  return [...byOwners.values()];
}
