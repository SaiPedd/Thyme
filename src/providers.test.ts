import { describe, expect, test } from "bun:test";
import { mask, normalizeHandle, parseProviders } from "./providers";

describe("parseProviders", () => {
  test("defaults to terminal when unset or empty", () => {
    expect(parseProviders(undefined)).toEqual(["terminal"]);
    expect(parseProviders("")).toEqual(["terminal"]);
    expect(parseProviders(" , ")).toEqual(["terminal"]);
  });

  test("trims whitespace, lowercases, and removes duplicates", () => {
    expect(parseProviders(" terminal , IMESSAGE,terminal ")).toEqual(["terminal", "imessage"]);
  });

  test("accepts both providers", () => {
    expect(parseProviders("terminal,imessage")).toEqual(["terminal", "imessage"]);
  });

  test("rejects unknown names, including the dropped local provider", () => {
    expect(() => parseProviders("terminal,whatsapp")).toThrow(/unknown provider "whatsapp"/);
    expect(() => parseProviders("imessage-local")).toThrow(/unknown provider/);
  });
});

describe("normalizeHandle", () => {
  test("formatted US number becomes +1 E.164", () => {
    expect(normalizeHandle("(609) 555-0101")).toBe("+16095550101");
    expect(normalizeHandle("1 609 555 0101")).toBe("+16095550101");
  });

  test("existing E.164 is unchanged", () => {
    expect(normalizeHandle("+16095550101")).toBe("+16095550101");
  });

  test("email is lowercased", () => {
    expect(normalizeHandle(" Roomie@Example.com ")).toBe("roomie@example.com");
  });
});

describe("mask", () => {
  test("shows only the last 4 characters", () => {
    expect(mask("+16095550101")).toBe("…0101");
    expect(mask("+16095550101")).not.toContain("609555");
  });
});
