// The only place allowed to read the real time. Everything else calls now().
// A demo offset lets us "skip two days" without touching the system clock.

const DAY_MS = 24 * 60 * 60 * 1000;
let offsetMs = 0;

/** Current time, including any demo offset. */
export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

/** Move the fake clock forward (or back, with a negative value). */
export function advance(ms: number): Date {
  offsetMs += ms;
  return now();
}

export function advanceDays(days: number): Date {
  return advance(days * DAY_MS);
}

/** Jump the fake clock to a specific moment. */
export function setNow(target: Date): Date {
  offsetMs = target.getTime() - Date.now();
  return now();
}

/** The current demo offset in ms (persisted by `bun run time-travel` in the state table). */
export function getOffsetMs(): number {
  return offsetMs;
}

export function setOffsetMs(ms: number): void {
  offsetMs = ms;
}

/** Back to real time. */
export function resetClock(): void {
  offsetMs = 0;
}

/** Add whole days to a date (pure, no clock read). */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
