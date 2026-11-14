import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { openDb } from "./src/db";
import { ensureShelfLife } from "./src/foodkeeper";
import { mask, normalizeHandle, parseProviders } from "./src/providers";

// Step 1: echo bot. PROVIDERS (in .env) picks any of: terminal, imessage (Photon cloud).
// Cloud iMessage needs SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET; never print them.
// Safety guard while testing: only echo iMessage senders in ECHO_ALLOWLIST.

let names;
try {
  names = parseProviders(process.env.PROVIDERS);
} catch (error) {
  console.error(`[start] ${(error as Error).message}`);
  process.exit(1);
}

const useCloud = names.includes("imessage");
const projectId = process.env.SPECTRUM_PROJECT_ID;
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
if (useCloud) {
  const missing = [
    !projectId && "SPECTRUM_PROJECT_ID",
    !projectSecret && "SPECTRUM_PROJECT_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`[start] PROVIDERS includes imessage but ${missing.join(" and ")} missing in .env`);
    process.exit(1);
  }
}

// Database: create tables, and import USDA FoodKeeper on first run.
const db = openDb();
try {
  const imported = await ensureShelfLife(db);
  if (imported) console.log(`[start] imported ${imported} FoodKeeper products`);
} catch (error) {
  console.error(`[start] FoodKeeper import failed: ${(error as Error).message}`);
  process.exit(1);
}

const allowlist = new Set(
  (process.env.ECHO_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeHandle),
);

const providers = [
  ...(names.includes("terminal") ? [terminal.config()] : []),
  ...(useCloud ? [imessage.config()] : []),
];

// Runtime-selected list, so types lose which providers are present.
const app = useCloud
  ? await Spectrum({ projectId: projectId!, projectSecret: projectSecret!, providers: providers as any })
  : await Spectrum({ providers: providers as any });
console.log(`[start] providers=${names.join(",")}`);

process.on("SIGINT", async () => {
  await app.stop();
  db.close();
  process.exit(0);
});

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  if (message.content.type !== "text") continue;

  let who = "";
  if (imessage.is(message)) {
    const sender = normalizeHandle(message.sender?.id ?? "");
    const allowed = allowlist.has(sender);
    who = ` ${mask(sender)}`;
    const kind = (message.space as { type?: string }).type ?? "?";
    console.log(`[in] ${message.platform} ${kind} from${who} allowlisted=${allowed}`);
    // Groups are echoed too. Later features must only post shared household info in
    // groups; personal items stay in the owner's DM (CLAUDE.md).
    if (!allowed) continue;
  } else {
    console.log(`[in] ${message.platform}`);
  }

  const text = message.content.text;
  try {
    await space.responding(async () => {
      await space.send(`echo: ${text}`);
    });
    console.log(`[out] ${message.platform} to${who} ok`);
  } catch (error) {
    console.log(`[out] ${message.platform} to${who} failed: ${(error as Error).message}`);
  }
}
