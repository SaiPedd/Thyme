import { afterEach, describe, expect, test } from "bun:test";
import { addDays, advanceDays, now, resetClock, setNow } from "./clock";

afterEach(() => resetClock());

describe("clock", () => {
  test("advanceDays moves now() forward by whole days", () => {
    const before = now().getTime();
    advanceDays(2);
    const diff = now().getTime() - before;
    // Allow a few ms for the time between the two reads.
    expect(diff).toBeGreaterThanOrEqual(2 * 86_400_000);
    expect(diff).toBeLessThan(2 * 86_400_000 + 1000);
  });

  test("setNow jumps to an exact moment and keeps ticking from there", () => {
    const target = new Date("2026-12-20T09:00:00Z");
    setNow(target);
    const t = now().getTime() - target.getTime();
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(1000);
  });

  test("resetClock returns to real time", () => {
    advanceDays(5);
    resetClock();
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(1000);
  });

  test("addDays is pure", () => {
    const d = new Date("2026-11-14T12:00:00Z");
    expect(addDays(d, 3).toISOString()).toBe("2026-11-17T12:00:00.000Z");
    expect(d.toISOString()).toBe("2026-11-14T12:00:00.000Z");
  });
});
