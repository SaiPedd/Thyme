// Phase 0 spike: does Claw Messenger work for us? Logs metadata only.
// Never logs message text, full phone numbers, the API key, the WebSocket URL, or attachment URLs.
//
// 1. GET readiness.  2. Open the WebSocket.  3. Create a group with CLAW_TEST_NUMBERS and send a DM
//    to the first number.  4. Listen for SPIKE_MINUTES (default 5): reply in the group, DM the bot,
//    and send a photo in the group.  5. Print a report: group vs dm mode, receipt photos in scope?
//
// Usage: bun run spike

import { loadConfig } from "../src/config";
import { mask } from "../src/domain/phone";

const BASE = "https://claw-messenger.onrender.com";
const { config } = loadConfig();
const key = config.clawApiKey;
if (!key) {
  console.error("[spike] CLAW_API_KEY missing in .env");
  process.exit(1);
}
const numbers = config.testNumbers;
if (numbers.length === 0) {
  console.error("[spike] CLAW_TEST_NUMBERS has no valid +E.164 numbers");
  process.exit(1);
}

/** Strip the key and mask phone numbers in anything we might print (errors can echo the URL or numbers). */
const safe = (s: unknown) =>
  String(s ?? "")
    .split(key)
    .join("***")
    .replace(/\+?\d{10,15}/g, (m) => mask(m));
const log = (...parts: unknown[]) => console.log("[spike]", ...parts.map(safe));

const report = {
  readiness: "not checked",
  connected: false,
  groupCreate: "not attempted",
  groupChatId: undefined as string | undefined,
  dmSend: "not attempted",
  inboundGroup: 0,
  inboundDm: 0,
  statusEvents: [] as string[],
  photo: "no photo received",
  otherTypes: new Set<string>(),
};

// 1. Readiness
try {
  const res = await fetch(`${BASE}/api/agent/readiness`, { headers: { Authorization: `Bearer ${key}` } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  report.readiness = `HTTP ${res.status}, ready=${String(body.ready)}`;
  log("readiness:", report.readiness, "fields:", Object.keys(body).join(","));
} catch (error) {
  report.readiness = `request failed: ${safe((error as Error).message)}`;
  log("readiness:", report.readiness);
}

// 2. WebSocket
const pending = new Map<string, "group" | "dm">();
const ws = new WebSocket(`${BASE.replace("https", "wss")}/ws?key=${encodeURIComponent(key)}`);
const send = (msg: Record<string, unknown>) => ws.send(JSON.stringify(msg));

async function testAttachment(att: { url?: string; mimeType?: string }) {
  if (!att.url) {
    report.photo = `attachment without url (mime ${att.mimeType ?? "?"})`;
    return;
  }
  for (const auth of [false, true]) {
    try {
      const res = await fetch(att.url, auth ? { headers: { Authorization: `Bearer ${key}` } } : undefined);
      const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0; // read, then discard
      report.photo =
        `download ${res.ok ? "OK" : "FAILED"} (HTTP ${res.status}${auth ? ", with Bearer key" : ", no auth"}), ` +
        `declared mime ${att.mimeType ?? "?"}, served ${res.headers.get("content-type") ?? "?"}, ${bytes} bytes`;
      log("photo:", report.photo);
      if (res.ok || ![401, 403].includes(res.status)) return;
    } catch (error) {
      report.photo = `download error: ${safe((error as Error).message)}`;
      log("photo:", report.photo);
      return;
    }
  }
}

ws.addEventListener("open", () => {
  report.connected = true;
  log("websocket open");
  if (numbers.length >= 2) {
    const id = crypto.randomUUID();
    pending.set(id, "group");
    send({
      type: "send",
      id,
      to: numbers,
      parts: [{ type: "text", value: "Fridge Squad test group. Reply here, then send a photo of a receipt." }],
    });
    log(`creating group with ${numbers.length} numbers (${numbers.map(mask).join(", ")})`);
  } else {
    report.groupCreate = "skipped: needs at least 2 valid CLAW_TEST_NUMBERS";
    log(report.groupCreate);
  }
  const dmId = crypto.randomUUID();
  pending.set(dmId, "dm");
  send({ type: "send", id: dmId, to: numbers[0], parts: [{ type: "text", value: "Fridge Squad test DM. Reply here." }] });
  log(`sending DM to ${mask(numbers[0])}`);
});

ws.addEventListener("message", async (event) => {
  let msg: Record<string, any>;
  try {
    msg = JSON.parse(String(event.data));
  } catch {
    log("non-JSON frame,", String(event.data).length, "chars");
    return;
  }
  switch (msg.type) {
    case "ping":
      send({ type: "pong" });
      return;
    case "pong":
      return;
    case "send.result": {
      const which = pending.get(msg.id) ?? "unknown";
      // On failure, include every field except ids and text, so we can see the reason.
      const extra = msg.ok
        ? ""
        : " " +
          Object.entries(msg)
            .filter(([k]) => !["type", "id", "ok", "status", "retryable", "chatId", "messageId", "text", "parts"].includes(k))
            .map(([k, v]) => `${k}=${safe(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 200)}`)
            .join(" ");
      const summary = `ok=${msg.ok} status=${msg.status ?? "?"} retryable=${msg.retryable ?? "?"} chatId=${msg.chatId ? "yes" : "no"}${extra}`;
      if (which === "group") {
        report.groupCreate = summary;
        report.groupChatId = msg.chatId;
      } else if (which === "dm") report.dmSend = summary;
      log(`send.result (${which}):`, summary, msg.chatId ? `chatId=${msg.chatId}` : "");
      return;
    }
    case "status":
      report.statusEvents.push(String(msg.status));
      log("status:", msg.status, "for", msg.messageId ? `message …${String(msg.messageId).slice(-6)}` : "?");
      return;
    case "message": {
      const atts: { url?: string; mimeType?: string }[] = msg.attachments ?? [];
      if (msg.isGroup) report.inboundGroup++;
      else report.inboundDm++;
      log(
        "message:",
        `from=${mask(msg.from)}`,
        `chatId=${msg.chatId}`,
        `isGroup=${msg.isGroup}`,
        `participants=${Array.isArray(msg.participants) ? msg.participants.length : "?"}`,
        `attachments=${atts.length}${atts.length ? ` (${atts.map((a) => a.mimeType ?? "?").join(",")})` : ""}`,
        msg.replay ? "replay=true" : "",
      );
      if (atts[0]) await testAttachment(atts[0]);
      return;
    }
    default:
      report.otherTypes.add(String(msg.type));
      log("event:", msg.type, "fields:", Object.keys(msg).join(","));
  }
});

ws.addEventListener("error", () => log("websocket error (details withheld: they can contain the URL)"));
ws.addEventListener("close", (e) => log(`websocket closed: code ${e.code}${e.reason ? `, reason "${safe(e.reason)}"` : ""}`));

const pinger = setInterval(() => ws.readyState === WebSocket.OPEN && send({ type: "ping" }), 30_000);
const minutes = Number(process.env.SPIKE_MINUTES ?? 5);
log(`listening for ${minutes} min. From your phones: reply in the group, reply to the DM, and send a photo in the group.`);

await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
clearInterval(pinger);
ws.close();

// 5. Report
const groupsWork = report.inboundGroup > 0;
const photoOk = report.photo.startsWith("download OK");
console.log(`
===== Claw spike report =====
readiness:        ${report.readiness}
websocket:        ${report.connected ? "connected" : "never connected"}
group create:     ${report.groupCreate}${report.groupChatId ? ` (chatId ${report.groupChatId})` : ""}
DM send:          ${report.dmSend}
inbound group:    ${report.inboundGroup} message(s)
inbound DM:       ${report.inboundDm} message(s)
delivery status:  ${report.statusEvents.join(", ") || "none"}
photo:            ${report.photo}
other events:     ${[...report.otherTypes].join(", ") || "none"}

recommendation:
  HOUSEHOLD_MODE=${groupsWork ? "group  (group messages arrived)" : "dm     (no group messages arrived)"}
  receipt photos ${photoOk ? "IN scope (attachment downloaded)" : "OUT of scope for now (no downloadable photo)"}
=============================`);
process.exit(0);
