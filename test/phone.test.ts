import { describe, expect, test } from "bun:test";
import { mask, normalizePhone } from "../src/domain/phone";

describe("normalizePhone", () => {
  test("formatted US numbers become +1 E.164", () => {
    expect(normalizePhone("(609) 555-0101")).toBe("+16095550101");
    expect(normalizePhone("1 609 555 0101")).toBe("+16095550101");
    expect(normalizePhone("+16095550101")).toBe("+16095550101");
  });

  test("rejects emails, placeholders, and junk", () => {
    expect(normalizePhone("roomie@example.com")).toBeNull();
    expect(normalizePhone("+1XXXXXXXXXX")).toBeNull();
    expect(normalizePhone("555")).toBeNull();
  });
});

describe("mask", () => {
  test("shows only the last 4 characters", () => {
    expect(mask("+16095550101")).toBe("…0101");
    expect(mask("+16095550101")).not.toContain("609555");
    expect(mask(undefined)).toBe("…????");
  });
});
