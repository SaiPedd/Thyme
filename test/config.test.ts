import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const SECRET_KEY = "cm_live_supersecretvalue123";
const GEMINI = "AIzaSecretValue456";

describe("loadConfig", () => {
  test("defaults and a clean report", () => {
    const { config, errors } = loadConfig({ CLAW_API_KEY: SECRET_KEY, GEMINI_API_KEY: GEMINI });
    expect(errors).toEqual([]);
    expect(config).toMatchObject({ householdMode: "group", llm: true, botName: "Thyme", householdTz: "America/New_York" });
  });

  test("the report never contains secret values or full phone numbers", () => {
    const { report, warnings, errors } = loadConfig({
      CLAW_API_KEY: SECRET_KEY,
      GEMINI_API_KEY: GEMINI,
      CLAW_TEST_NUMBERS: "+16095550101,+16095550102",
    });
    const all = [...report, ...warnings, ...errors].join("\n");
    expect(all).not.toContain(SECRET_KEY);
    expect(all).not.toContain(GEMINI);
    expect(all).not.toContain("6095550101");
    expect(all).toContain("…0101");
  });

  test("flags missing claw key, bad mode, bad tz, and placeholder numbers", () => {
    const { errors, warnings, config } = loadConfig({
      HOUSEHOLD_MODE: "both",
      HOUSEHOLD_TZ: "Mars/Olympus",
      CLAW_TEST_NUMBERS: "+16095550101,+1XXXXXXXXXX",
    });
    expect(errors.join()).toContain("CLAW_API_KEY");
    expect(errors.join()).toContain("HOUSEHOLD_MODE");
    expect(errors.join()).toContain("HOUSEHOLD_TZ");
    expect(warnings.join()).toContain("entry 2");
    expect(config.testNumbers).toEqual(["+16095550101"]);
  });

  test("LLM=off does not warn about a missing Gemini key", () => {
    const { warnings } = loadConfig({ CLAW_API_KEY: SECRET_KEY, LLM: "off" });
    expect(warnings.join()).not.toContain("GEMINI_API_KEY");
  });
});
