// Price estimates for items logged without a price (data/prices.json). Receipts or the user's own
// number always win; an estimate is stored with cost_source = 'estimate'.

import { readFileSync } from "node:fs";

const PRICES: Record<string, number> = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL("../../data/prices.json", import.meta.url), "utf8")) as Record<string, unknown>).filter(
    (e): e is [string, number] => typeof e[1] === "number",
  ),
);

/** Estimated price in cents for an item name ("baby spinach", "Bananas"), or null if unknown. */
export function estimatePriceCents(name: string): number | null {
  const n = name.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return null;
  const words = n.split(" ");
  const tries = [n, n.replace(/s$/, ""), `${n}s`, words.at(-1)!, `${words.at(-1)!}s`, words.at(-1)!.replace(/s$/, "")];
  for (const t of tries) if (PRICES[t] !== undefined) return PRICES[t]!;
  return null;
}
