import { describe, expect, test } from "bun:test";
import { formatCents, parseCents } from "../src/domain/money";
import { computeSplit, debtsFromShares, expenseDedupeHash, SplitError } from "../src/domain/splits";

const sum = (m: Map<number, number>) => [...m.values()].reduce((s, v) => s + v, 0);

describe("money", () => {
  test("parses dollars to integer cents", () => {
    expect(parseCents("$48.60")).toBe(4860);
    expect(parseCents("48.6")).toBe(4860);
    expect(parseCents("$9")).toBe(900);
    expect(parseCents("$1,204.05")).toBe(120405);
    expect(parseCents(12.34)).toBe(1234);
    expect(parseCents("nothing")).toBeNull();
  });

  test("formats cents", () => {
    expect(formatCents(4860)).toBe("$48.60");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(-1320)).toBe("-$13.20");
  });
});

describe("computeSplit", () => {
  test("the demo: $48.60 split 3 ways, chicken thighs ($9) are just mine", () => {
    const { shares, mode } = computeSplit({
      totalCents: 4860,
      buyerId: 1,
      memberIds: [1, 2, 3],
      allocations: [{ amountCents: 900, memberIds: [1] }],
    });
    expect(mode).toBe("per_item");
    expect(Object.fromEntries(shares)).toEqual({ 1: 2220, 2: 1320, 3: 1320 });
  });

  test("equal split gives leftover cents to the buyer", () => {
    const { shares, mode } = computeSplit({ totalCents: 1000, buyerId: 2, memberIds: [1, 2, 3] });
    expect(mode).toBe("equal");
    expect(Object.fromEntries(shares)).toEqual({ 1: 333, 2: 334, 3: 333 });
  });

  test("subset: the milk is just me and Sam", () => {
    const { shares, mode } = computeSplit({
      totalCents: 2000,
      buyerId: 1,
      memberIds: [1, 2, 3],
      allocations: [{ amountCents: 501, memberIds: [1, 2] }],
    });
    expect(mode).toBe("subset");
    expect(sum(shares)).toBe(2000);
    expect(shares.get(3)).toBe(Math.floor(1499 / 3));
  });

  test("custom: Sam owes 8, the rest split among everyone else", () => {
    const { shares, mode } = computeSplit({
      totalCents: 3000,
      buyerId: 1,
      memberIds: [1, 2, 3],
      fixed: [{ memberId: 2, amountCents: 800 }],
    });
    expect(mode).toBe("custom");
    expect(Object.fromEntries(shares)).toEqual({ 1: 1100, 2: 800, 3: 1100 });
  });

  test("rejects items worth more than the total, and outsiders", () => {
    expect(() => computeSplit({ totalCents: 500, buyerId: 1, memberIds: [1, 2], allocations: [{ amountCents: 900, memberIds: [1] }] })).toThrow(SplitError);
    expect(() => computeSplit({ totalCents: 500, buyerId: 9, memberIds: [1, 2] })).toThrow(SplitError);
    expect(() => computeSplit({ totalCents: 500, buyerId: 1, memberIds: [1, 2], allocations: [{ amountCents: 100, memberIds: [7] }] })).toThrow(SplitError);
    expect(() => computeSplit({ totalCents: 0, buyerId: 1, memberIds: [1, 2] })).toThrow(SplitError);
  });

  test("property: shares always sum exactly to the total, never negative", () => {
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 2000; i++) {
      const members = Array.from({ length: 1 + rand(5) }, (_, k) => k + 1);
      const buyerId = members[rand(members.length)]!;
      const totalCents = 1 + rand(50_000);
      const allocations = Array.from({ length: rand(3) }, () => ({
        amountCents: rand(Math.max(1, Math.floor(totalCents / 4))),
        memberIds: members.filter(() => rand(2) === 0).concat(members[0]!),
      }));
      const { shares } = computeSplit({ totalCents, buyerId, memberIds: members, allocations });
      expect(sum(shares)).toBe(totalCents);
      for (const v of shares.values()) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("debts and dedupe", () => {
  test("non-buyers owe the buyer their share", () => {
    const shares = new Map([[1, 2220], [2, 1320], [3, 1320]]);
    expect(debtsFromShares(shares, 1)).toEqual([
      { debtorId: 2, creditorId: 1, amountCents: 1320 },
      { debtorId: 3, creditorId: 1, amountCents: 1320 },
    ]);
  });

  test("dedupe hash is stable per buyer, total, and date", () => {
    expect(expenseDedupeHash(1, 4860, "2026-11-14")).toBe(expenseDedupeHash(1, 4860, "2026-11-14"));
    expect(expenseDedupeHash(1, 4860, "2026-11-14")).not.toBe(expenseDedupeHash(1, 4860, "2026-11-15"));
    expect(expenseDedupeHash(1, 4860, "2026-11-14")).not.toBe(expenseDedupeHash(2, 4860, "2026-11-14"));
  });
});
