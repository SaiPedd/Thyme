// Register phone numbers with Claw Messenger (POST /api/routes). Unregistered numbers are ignored,
// and group creation needs every participant registered. Growth plan: 5 registered numbers max.
// Usage: bun run register-phones [+1..., +1...]   (defaults to CLAW_TEST_NUMBERS)
// Logs masked numbers and HTTP status only.

import { loadConfig } from "../src/config";
import { mask, normalizePhone } from "../src/domain/phone";

const BASE = "https://claw-messenger.onrender.com";
const { config } = loadConfig();
const key = config.clawApiKey;
if (!key) {
  console.error("[register] CLAW_API_KEY missing in .env");
  process.exit(1);
}

const args = process.argv.slice(2).join(",").split(",").map((s) => s.trim()).filter(Boolean);
const numbers = args.length ? args.map(normalizePhone).filter((p): p is string => p !== null) : config.testNumbers;
if (numbers.length === 0) {
  console.error("[register] no valid +E.164 numbers (pass them as arguments or set CLAW_TEST_NUMBERS)");
  process.exit(1);
}

/** Error bodies can echo the number; mask anything that looks like one. */
const scrub = (s: string) => s.split(key).join("***").replace(/\+?\d{10,15}/g, (m) => mask(m)).slice(0, 200);

let failures = 0;
for (const phone of numbers) {
  const res = await fetch(`${BASE}/api/routes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ phone_number: phone }),
  });
  const body = await res.text().catch(() => "");
  const ok = res.ok || res.status === 409; // 409 = already registered (if the API uses it)
  if (!ok) failures++;
  console.log(`[register] ${mask(phone)}: HTTP ${res.status}${ok ? " ok" : ""}${body && !res.ok ? ` (${scrub(body)})` : ""}`);
  if (body.includes("phone_route_limit_reached")) {
    console.log("[register] plan limit reached: upgrade at clawmessenger.com/dashboard to register more numbers");
    break;
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") ?? 5);
    console.log(`[register] rate limited, waiting ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}
process.exit(failures ? 1 : 0);
