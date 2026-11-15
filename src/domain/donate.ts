// Giving food away instead of tossing it: which local pantry can take it. Places come only from the
// hand-checked list in data/donation-sites.json; the model never names or invents one.
// Food safety is decided here, in code:
// - past its USDA FoodKeeper date: never donate, toss it.
// - shelf-stable (kept in the pantry): sealed and unopened, to a pantry that takes non-perishables.
// - fresh (fridge or freezer): pantries here don't take drop-offs; offer it to the house first, or
//   arrange it with a place that delivers fresh food.

import { readFileSync } from "node:fs";
import { isPast, type Item } from "./inventory";

export type Accepts = "shelf_stable" | "fresh_by_arrangement";

export interface DonationSite {
  id: string;
  name: string;
  address: string;
  contact: string;
  accepts: Accepts[];
  how: string;
  checked: string;
}

export const DONATION_SITES: DonationSite[] = (
  JSON.parse(readFileSync(new URL("../../data/donation-sites.json", import.meta.url), "utf8")) as { sites: DonationSite[] }
).sites;

export type DonationAdvice =
  | { ok: false; reason: "past_date"; item: string }
  | { ok: true; item?: string; kind: "shelf_stable" | "fresh" | "any"; sites: DonationSite[]; rules: string[] };

/** Where this food can go (or, with no item, every place on the list). */
export function donationAdvice(item: Item | null, sites: DonationSite[] = DONATION_SITES): DonationAdvice {
  if (!item) return { ok: true, kind: "any", sites, rules: ["Only sealed, unopened food that is within its date."] };
  if (isPast(item)) return { ok: false, reason: "past_date", item: item.name };
  if (item.storage === "pantry") {
    return {
      ok: true,
      item: item.name,
      kind: "shelf_stable",
      sites: sites.filter((s) => s.accepts.includes("shelf_stable")),
      rules: ["Only if it's sealed and unopened."],
    };
  }
  return {
    ok: true,
    item: item.name,
    kind: "fresh",
    sites: sites.filter((s) => s.accepts.includes("fresh_by_arrangement")),
    rules: ["Food pantries here don't take fresh food as a drop-off. Offer it to the house first.", "To give it away, arrange it first:"],
  };
}

/** Fixed wording for the advice: addresses and rules are never paraphrased by the model. */
export function describeDonation(a: DonationAdvice): string {
  if (!a.ok) return `The ${a.item} is past its USDA FoodKeeper date, so it can't be donated. To be safe, toss it.`;
  const head =
    a.kind === "any"
      ? "Places near Princeton that take food donations:"
      : a.kind === "shelf_stable"
        ? `The ${a.item} can be donated. ${a.rules[0]}`
        : `The ${a.item} is fresh food. ${a.rules[0]} ${a.rules[1]}`;
  const lines = a.sites.map((s) => `- ${s.name}: ${s.address}. ${s.how} Contact: ${s.contact}.`);
  return [head, ...(lines.length ? lines : ["- I don't have a place for this yet."]), ...(a.kind === "any" ? [a.rules[0]!] : [])].join("\n");
}
