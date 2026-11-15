// Environment config, validated once at startup. The preflight report never prints secret values,
// full phone numbers, or the WebSocket URL.

import { mask, normalizePhone } from "./domain/phone";

export type HouseholdMode = "group" | "dm";

export interface Config {
  clawApiKey: string | undefined;
  geminiApiKey: string | undefined;
  geminiModel: string;
  llm: boolean;
  householdMode: HouseholdMode;
  botName: string;
  /** Other names that get the agent's attention, e.g. "thymey". */
  botAliases: string[];
  householdTz: string;
  testNumbers: string[];
  dbPath: string;
  /** Use TheMealDB for recipe ideas (MEALDB=off for built-in recipes only). */
  mealdb: boolean;
  /** TheMealDB key: "1" is the free development/educational key; a supporter key for public releases. */
  mealdbApiKey: string;
}

export interface Loaded {
  config: Config;
  errors: string[];
  warnings: string[];
  /** One line per setting, safe to print. */
  report: string[];
}

type Env = Record<string, string | undefined>;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: Env = process.env, opts: { requireClaw?: boolean } = {}): Loaded {
  const errors: string[] = [];
  const warnings: string[] = [];
  const val = (k: string) => (env[k]?.trim() ? env[k]!.trim() : undefined);

  const clawApiKey = val("CLAW_API_KEY");
  if (!clawApiKey) (opts.requireClaw === false ? warnings : errors).push("CLAW_API_KEY is missing (needed for the claw adapter)");
  else if (!clawApiKey.startsWith("cm_live_")) warnings.push("CLAW_API_KEY does not start with cm_live_");

  const llm = (val("LLM") ?? "on").toLowerCase() !== "off";
  const geminiApiKey = val("GEMINI_API_KEY");
  if (llm && !geminiApiKey) warnings.push("GEMINI_API_KEY is missing: the agent will use the rule-based fallback");

  const modeRaw = (val("HOUSEHOLD_MODE") ?? "group").toLowerCase();
  let householdMode: HouseholdMode = "group";
  if (modeRaw === "group" || modeRaw === "dm") householdMode = modeRaw;
  else errors.push(`HOUSEHOLD_MODE must be group or dm (got "${modeRaw}")`);

  const householdTz = val("HOUSEHOLD_TZ") ?? "America/New_York";
  if (!validTimeZone(householdTz)) errors.push(`HOUSEHOLD_TZ "${householdTz}" is not a valid time zone`);

  const rawNumbers = (val("CLAW_TEST_NUMBERS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const testNumbers: string[] = [];
  rawNumbers.forEach((raw, i) => {
    const phone = normalizePhone(raw);
    if (phone) testNumbers.push(phone);
    else warnings.push(`CLAW_TEST_NUMBERS entry ${i + 1} is not a valid +E.164 phone number`);
  });

  const config: Config = {
    clawApiKey,
    geminiApiKey,
    geminiModel: val("GEMINI_MODEL") ?? "gemini-3.5-flash-lite",
    llm,
    householdMode,
    botName: val("BOT_NAME") ?? "Thyme",
    botAliases: (val("BOT_ALIASES") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    householdTz,
    testNumbers,
    dbPath: val("DB_PATH") ?? "data/fridge.db",
    mealdb: (val("MEALDB") ?? "on").toLowerCase() !== "off",
    mealdbApiKey: val("MEALDB_API_KEY") ?? "1",
  };

  const secret = (v: string | undefined) => (v ? "set" : "MISSING");
  const report = [
    `CLAW_API_KEY       ${secret(clawApiKey)}`,
    `GEMINI_API_KEY     ${secret(geminiApiKey)}`,
    `GEMINI_MODEL       ${config.geminiModel}`,
    `LLM                ${llm ? "on" : "off"}`,
    `HOUSEHOLD_MODE     ${householdMode}`,
    `BOT_NAME           ${config.botName}${config.botAliases.length ? ` (also: ${config.botAliases.join(", ")})` : ""}`,
    `HOUSEHOLD_TZ       ${householdTz}`,
    `CLAW_TEST_NUMBERS  ${testNumbers.length ? testNumbers.map(mask).join(", ") : "none"}`,
    `DB_PATH            ${config.dbPath}`,
    `MEALDB             ${config.mealdb ? `on (${config.mealdbApiKey === "1" ? "free test key" : "MEALDB_API_KEY set"})` : "off"}`,
  ];
  return { config, errors, warnings, report };
}

/** Print the preflight report. Returns false if there are blocking errors. */
export function printPreflight(loaded: Loaded, log: (line: string) => void = console.log): boolean {
  log("[preflight]");
  for (const line of loaded.report) log(`  ${line}`);
  for (const w of loaded.warnings) log(`  warning: ${w}`);
  for (const e of loaded.errors) log(`  ERROR: ${e}`);
  return loaded.errors.length === 0;
}
