# Spectrum (spectrum-ts) quick reference

Source: https://photon.codes/docs/spectrum-ts/introduction and getting-started (Stable docs).
Full index for anything missing: https://docs.photon.codes/docs/llms.txt

## What it is
Unified TypeScript messaging SDK. One agent server, many providers (iMessage, WhatsApp Business,
Telegram, terminal, SIP voice). Providers handle platform details. Our code owns the agent logic.
All providers feed one message stream.

## Install
- `bun add spectrum-ts` (bundles core plus standard providers, including terminal and cloud iMessage)
- Local iMessage is separate and macOS only: `bun add @spectrum-ts/imessage-local`
  - Import it explicitly. There is no `spectrum-ts/providers/imessage-local` path.
- Needs TypeScript 5 or 6.

## Core primitives
- **Message:** incoming content (text, attachments, structured data). Has `platform`, `sender?.id`, `content`.
- **Space:** a conversation context (DM, group, terminal session). You send into a space.
- **User:** a participant, with a platform-specific ID.
- **Provider:** adapter that translates a platform into Spectrum's interface.

Every incoming item is a tuple `[space, message]`.

## Minimal app (terminal, no credentials)
```ts
import { Spectrum } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum({ providers: [terminal.config()] });

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  await space.responding(async () => {
    await message.reply(`echo: ${message.content.text}`);
  });
}
```

## Local iMessage (this Mac's Messages app, no account)
```ts
import { localIMessage } from "@spectrum-ts/imessage-local";
const app = await Spectrum({ providers: [localIMessage.config()] });
```
- Use `localIMessage.is(message)` as the type guard. Comparing `message.platform` to a string does not narrow types.
- Inside the guard, `message.space.type` is `"dm" | "group"`.
- `message.sender.id` is a phone number or Apple ID email.
- Needs Full Disk Access (terminal app, fully quit and reopen) and Automation permission for Messages.

## Cloud (hosted) iMessage
- Credentials: PROJECT_ID and SECRET_KEY from https://app.photon.codes (project Settings).
- You MUST pass `projectId` and `projectSecret` to `Spectrum(...)` explicitly. Spectrum does NOT
  read them from env on its own (checked in the 12.16 source); without them the cloud provider
  throws "Cloud iMessage requires projectId and projectSecret". We keep them in `.env` as
  `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` and pass them in `index.ts`.
- Provider config can also come from env: `SPECTRUM_<PLATFORM>_<FIELD>` in UPPER_SNAKE_CASE
  (example: `SPECTRUM_TELEGRAM_BOT_TOKEN`). Explicit config wins over env.
- Supports DMs, groups, typing indicators, reactions, threaded replies, effects, backgrounds,
  per-line routing.
- Project IDs starting with `pho_prj_` mean the v2 Beta platform, which has separate docs
  (https://docs.photon.codes/docs/beta/photon.md). Use Stable unless told otherwise.
- Import: `import { imessage } from "spectrum-ts/providers/imessage"`. Guard with `imessage.is(message)`;
  inside it `message.space.type` is `"dm" | "group"`. Skip `message.direction === "outbound"`.
- Register every test phone in Dashboard -> Users (find its real handle at https://debug.photon.codes).
  Unregistered numbers only fail at send time with "Target not allowed for this project".
- The Free / Pro / promo plan uses a shared number pool. Per Photon's skill doc, groups need a
  dedicated line (Business plan); the shared pool rejects groups.
- Local iMessage does not support threaded replies: `message.reply()` warns and skips. Use
  `space.send()` for anything that must work on every provider.
- Messages sent while the process is stopped are not redelivered.
- Spectrum may deliver a message more than once: dedupe by `message.id` once we store messages.
- Send to someone first (not as a reply): `const im = imessage(app); await im.space.create(await im.user(handle))`.

## Multiple providers
```ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config(), terminal.config()],
});
```
Messages from all providers merge into `app.messages`. `message.platform` identifies the source.

## App instance API
```ts
app.messages                       // AsyncIterable of [space, message]
await app.send(space, ...)         // send into a space
await app.responding(space, fn)    // run fn with a typing indicator
await app.webhook(req, handler)    // handle an inbound webhook (native or Fusor)
await app.stop()                   // graceful shutdown (also flushes telemetry)
```
On a space: `space.send(...)`, `space.responding(fn)`. On a message: `message.reply(...)`.
Providers can also expose custom event streams as flat async iterables on `app`.

## Options
```ts
options: { logLevel: "debug" }   // default "info", overrides LOG_LEVEL env, secrets are redacted
telemetry: true                  // OpenTelemetry traces, OTEL_EXPORTER_OTLP_* env vars override
```

## Custom platforms
`definePlatform` builds a custom provider (web simulator, internal tools, etc.).
Docs: https://docs.photon.codes/docs/spectrum-ts/custom-platforms.md

## More docs
- Quickstart: https://docs.photon.codes/docs/spectrum-ts/getting-started.md
- Providers overview: https://docs.photon.codes/docs/spectrum-ts/providers.md
- iMessage provider: https://docs.photon.codes/docs/spectrum-ts/providers/imessage
- Terminal provider: https://docs.photon.codes/docs/spectrum-ts/providers/terminal
- Webhooks: https://docs.photon.codes/docs/spectrum-ts/webhooks.md
- Custom events and lifecycle: https://docs.photon.codes/docs/spectrum-ts/custom-events-and-lifecycle.md
- Symbols: https://docs.photon.codes/docs/reference/stable/spectrum-ts/symbols/message.md
  (also `space.md`, `user.md`, `spectruminstance.md` in the same folder)

## Project notes
- `PROVIDERS` in `.env` picks any of `terminal`, `imessage` (default terminal); see
  `src/providers.ts`. We do NOT use local iMessage: in testing it never delivered incoming texts
  (its file watcher likely did not fire under Bun) and it replies as your own Apple ID. Do not guess API details. If something is not
  covered here, fetch the matching docs page first.
