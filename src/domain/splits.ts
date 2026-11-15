// Pure split math. Integer cents only. Invariant: shares always sum exactly to the total.
// Leftover cents (from uneven division) go to the buyer when the buyer is in the group being
// split; otherwise to the lowest member id in that group, so results are deterministic.

export type SplitMode = "equal" | "per_item" | "subset" | "custom";

export interface SplitSpec {
  totalCents: number;
  buyerId: number;
  /** Everyone in the household who shares the remainder. */
  memberIds: number[];
  /** Line items split among a specific group: "chicken ($9) is just mine", "milk is me and Sam". */
  allocations?: { amountCents: number; memberIds: number[] }[];
  /** Fixed amounts: "Sam owes 8". Taken out first, the rest is split normally. */
  fixed?: { memberId: number; amountCents: number }[];
}

export interface SplitResult {
  mode: SplitMode;
  /** memberId -> cents. Includes every household member, 0 for those who owe nothing. */
  shares: Map<number, number>;
}

export class SplitError extends Error {}

function divide(amount: number, ids: number[], buyerId: number, into: Map<number, number>) {
  const group = [...new Set(ids)].sort((a, b) => a - b);
  if (group.length === 0) throw new SplitError("a split needs at least one person");
  const base = Math.floor(amount / group.length);
  const leftover = amount - base * group.length;
  for (const id of group) into.set(id, (into.get(id) ?? 0) + base);
  const gets = group.includes(buyerId) ? buyerId : group[0]!;
  into.set(gets, (into.get(gets) ?? 0) + leftover);
}

export function computeSplit(spec: SplitSpec): SplitResult {
  const { totalCents, buyerId } = spec;
  const members = [...new Set(spec.memberIds)];
  const allocations = spec.allocations ?? [];
  const fixed = spec.fixed ?? [];

  if (!Number.isInteger(totalCents) || totalCents <= 0) throw new SplitError("total must be a positive amount");
  if (!members.includes(buyerId)) throw new SplitError("the buyer must be a household member");
  const known = new Set(members);
  for (const a of allocations) {
    if (!Number.isInteger(a.amountCents) || a.amountCents < 0) throw new SplitError("item amounts must be positive");
    for (const id of a.memberIds) if (!known.has(id)) throw new SplitError("an item was assigned to someone outside the household");
  }
  for (const f of fixed) {
    if (!Number.isInteger(f.amountCents) || f.amountCents < 0) throw new SplitError("fixed amounts must be positive");
    if (!known.has(f.memberId)) throw new SplitError("a fixed amount was assigned to someone outside the household");
  }

  const taken = allocations.reduce((s, a) => s + a.amountCents, 0) + fixed.reduce((s, f) => s + f.amountCents, 0);
  const remainder = totalCents - taken;
  if (remainder < 0) throw new SplitError("the items add up to more than the total");

  const shares = new Map<number, number>(members.map((id) => [id, 0]));
  for (const f of fixed) shares.set(f.memberId, shares.get(f.memberId)! + f.amountCents);
  for (const a of allocations) if (a.amountCents > 0) divide(a.amountCents, a.memberIds, buyerId, shares);
  // Fixed amounts mean "this person owes exactly X": the remainder goes to everyone else.
  const rest = fixed.length ? members.filter((id) => !fixed.some((f) => f.memberId === id)) : members;
  if (remainder > 0) divide(remainder, rest.length ? rest : members, buyerId, shares);

  const sum = [...shares.values()].reduce((s, v) => s + v, 0);
  if (sum !== totalCents) throw new SplitError(`internal error: shares sum to ${sum}, not ${totalCents}`);

  const mode: SplitMode = fixed.length
    ? "custom"
    : allocations.some((a) => a.memberIds.length > 1 && a.memberIds.length < members.length)
      ? "subset"
      : allocations.length
        ? "per_item"
        : "equal";
  return { mode, shares };
}

/** Who owes whom: every non-buyer owes the buyer their share. */
export function debtsFromShares(shares: Map<number, number>, buyerId: number) {
  return [...shares]
    .filter(([id, cents]) => id !== buyerId && cents > 0)
    .map(([debtorId, amountCents]) => ({ debtorId, creditorId: buyerId, amountCents }));
}

/** Same buyer + same total + same local date = probably the same receipt logged twice. */
export function expenseDedupeHash(buyerId: number, totalCents: number, localDate: string): string {
  return new Bun.CryptoHasher("sha256").update(`${buyerId}|${totalCents}|${localDate}`).digest("hex");
}
