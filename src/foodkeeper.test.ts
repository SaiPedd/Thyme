import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { ensureShelfLife, expiryFor, loadShelfLife, parseFoodKeeper, toDays } from "./foodkeeper";

// Small fixture in the published FoodKeeper layout: sheets of rows, each row a list of one-key objects.
const fixture = {
  sheets: [
    {
      name: "Category",
      data: [
        [{ ID: 1 }, { Category_Name: "Produce" }, { Subcategory_Name: "Fresh Vegetables" }],
        [{ ID: 2 }, { Category_Name: "Meat" }, { Subcategory_Name: null }],
      ],
    },
    {
      name: "Product",
      data: [
        [
          { ID: 10 }, { Category_ID: 1 }, { Name: "Spinach" }, { Name_subtitle: null }, { Keywords: "spinach,greens" },
          { Refrigerate_Min: 3 }, { Refrigerate_Max: 7 }, { Refrigerate_Metric: "Days" },
        ],
        [
          // Only "from date of purchase" values, like fresh meat.
          { ID: 11 }, { Category_ID: 2 }, { Name: "Chicken" }, { Name_subtitle: "whole" }, { Keywords: "chicken" },
          { DOP_Refrigerate_Min: 1 }, { DOP_Refrigerate_Max: 2 }, { DOP_Refrigerate_Metric: "Days" },
          { Freeze_Min: 9 }, { Freeze_Max: 12 }, { Freeze_Metric: "Months" },
        ],
        [
          { ID: 12 }, { Category_ID: 1 }, { Name: "Rice" }, { Name_subtitle: "white, dry" },
          { Pantry_Min: 2 }, { Pantry_Max: 2 }, { Pantry_Metric: "Years" },
        ],
        [
          // Real USDA shape for milk: no fridge number, just guidance.
          { ID: 13 }, { Category_ID: 2 }, { Name: "Milk" }, { Refrigerate_Metric: "Package use-by date" },
          { DOP_Freeze_Min: 3 }, { DOP_Freeze_Max: 3 }, { DOP_Freeze_Metric: "Months" },
        ],
      ],
    },
  ],
};

describe("toDays", () => {
  test("converts units to whole days", () => {
    expect(toDays(3, "Days")).toBe(3);
    expect(toDays(2, "Weeks")).toBe(14);
    expect(toDays(1, "Month")).toBe(30);
    expect(toDays(2, "Years")).toBe(730);
    expect(toDays(12, "Hours")).toBe(1); // rounds up, at least 1 day
  });

  test("returns null for non-time metrics or missing amounts", () => {
    expect(toDays(null, "Days")).toBeNull();
    expect(toDays(1, "Package use-by date")).toBeNull();
    expect(toDays(1, undefined)).toBeNull();
  });
});

describe("parseFoodKeeper", () => {
  const rows = parseFoodKeeper(fixture);

  test("parses products with categories", () => {
    expect(rows.map((r) => r.name)).toEqual(["Spinach", "Chicken", "Rice", "Milk"]);
    expect(rows[0]!.category).toBe("Produce / Fresh Vegetables");
  });

  test("normalizes ranges per storage", () => {
    expect(rows[0]).toMatchObject({ fridge_min_days: 3, fridge_max_days: 7, pantry_min_days: null });
    expect(rows[2]).toMatchObject({ pantry_min_days: 730, pantry_max_days: 730 });
  });

  test("falls back to date-of-purchase values", () => {
    expect(rows[1]).toMatchObject({ fridge_min_days: 1, fridge_max_days: 2, freezer_min_days: 270 });
  });

  test("keeps USDA guidance when there is no number", () => {
    expect(rows[3]).toMatchObject({ fridge_min_days: null, fridge_note: "Package use-by date", freezer_min_days: 90, freezer_note: null });
    expect(rows[0]).toMatchObject({ fridge_note: null });
  });

  test("rejects JSON without the expected sheets", () => {
    expect(() => parseFoodKeeper({})).toThrow(/missing "Category" sheet/);
  });
});

describe("expiry math", () => {
  const [spinach, chicken] = parseFoodKeeper(fixture);
  const added = new Date("2026-11-14T18:00:00Z");

  test("uses the conservative minimum shelf life", () => {
    expect(expiryFor(spinach!, "fridge", added)!.toISOString()).toBe("2026-11-17T18:00:00.000Z");
    expect(expiryFor(chicken!, "fridge", added)!.toISOString()).toBe("2026-11-15T18:00:00.000Z");
  });

  test("returns null when FoodKeeper has no entry for that storage", () => {
    expect(expiryFor(spinach!, "pantry", added)).toBeNull();
  });
});

describe("ensureShelfLife", () => {
  test("imports when empty, skips when already loaded", async () => {
    const path = join(tmpdir(), `foodkeeper-test-${process.pid}.json`);
    await Bun.write(path, JSON.stringify(fixture));
    const db = openDb(":memory:");
    expect(await ensureShelfLife(db, path)).toBe(4);
    expect(await ensureShelfLife(db, path)).toBe(0);
  });

  test("fails clearly when the file is missing", async () => {
    const db = openDb(":memory:");
    expect(ensureShelfLife(db, "does/not/exist.json")).rejects.toThrow(/not found/);
  });
});

describe("loadShelfLife", () => {
  test("replaces table contents", () => {
    const db = openDb(":memory:");
    const rows = parseFoodKeeper(fixture);
    expect(loadShelfLife(db, rows)).toBe(4);
    expect(loadShelfLife(db, rows)).toBe(4); // reload doesn't duplicate
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shelf_life").get()!.n;
    expect(count).toBe(4);
  });
});
