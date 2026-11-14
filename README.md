# fridge-bud

An iMessage agent (Photon Spectrum) that helps roommates stop wasting food.
Built for HackPrinceton: Sustainability and Photon tracks. Plan: [PLAN.md](PLAN.md).

## Environment

Copy `.env.example` to `.env` and fill in:

- `PROVIDERS`: `terminal`, `imessage`, or both (comma-separated). Default `terminal`.
- `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`: from project Settings on the
  [Photon dashboard](https://app.photon.codes). Needed for `imessage`.
- `ECHO_ALLOWLIST`: phone numbers or emails the echo bot may reply to.

Register every test phone in the Photon Dashboard under Users.

## Run

```sh
bun install
bun start
bun test
```
