/**
 * Schedule math for the 24/7 scheduler (BRIDGE_APP_SPEC §2). Two shapes:
 *  - daily  at HH:MM in a timezone, with CATCH-UP: if the scheduled time has passed today and the
 *    task hasn't run today, it fires on the next tick — so a 02:00 close still happens if the box
 *    was asleep until 02:30. "No missed 2:00 closes" is the whole point.
 *  - interval every N ms — for pollers (the env channel, later).
 *
 * Pure functions over an injected `now`, so the scheduler is testable without real clocks.
 */
export type Schedule =
  | { kind: 'daily'; at: string; tz?: string; catchUp?: boolean; graceMinutes?: number }
  | { kind: 'interval'; everyMs: number };

export interface LocalParts { date: string; minutes: number; hhmm: string }

/** Local wall-clock parts in a timezone (date key + minutes since local midnight). */
export function localParts(now: Date, tz = 'America/Toronto'): LocalParts {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)?.value || '00';
  const hh = g('hour') === '24' ? '00' : g('hour'); // some ICU builds render midnight as 24
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(hh) * 60 + Number(g('minute')), hhmm: `${hh}:${g('minute')}` };
}

function parseHHMM(at: string): number {
  const [h, m] = at.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export interface DailyState { lastRunDate?: string }
export interface IntervalState { lastRunMs?: number }

/**
 * Daily due-check. Returns the date key to record if the task should fire now, else null.
 * catchUp (default true): fire any time at/after the scheduled minute if not yet run today.
 * graceMinutes (when catchUp is false): only fire within this window after the scheduled minute.
 */
export function dailyDue(s: Extract<Schedule, { kind: 'daily' }>, now: Date, state: DailyState): string | null {
  const { date, minutes } = localParts(now, s.tz);
  if (state.lastRunDate === date) return null;
  const scheduled = parseHHMM(s.at);
  if (minutes < scheduled) return null;
  const catchUp = s.catchUp !== false;
  if (!catchUp) {
    const grace = s.graceMinutes ?? 5;
    if (minutes > scheduled + grace) return null; // missed the window and not catching up
  }
  return date;
}

/** Interval due-check. Returns the ms timestamp to record if it should fire, else null. */
export function intervalDue(s: Extract<Schedule, { kind: 'interval' }>, now: Date, state: IntervalState): number | null {
  const t = now.getTime();
  if (state.lastRunMs === undefined) return t; // first run fires immediately
  return t - state.lastRunMs >= s.everyMs ? t : null;
}
