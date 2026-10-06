/** Calendar days in a named time zone (the owner's reports and limits run on London days). */

export const LONDON = 'Europe/London';

function wallClock(instant: Date, timeZone: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

/** Minutes the zone is ahead of UTC at that instant (London: 0 in winter, 60 in summer). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** The UTC instant of a wall-clock time in the zone. */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  // Two passes settle the offset even on the day the clocks change.
  let t = guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60_000;
  t = guess - zoneOffsetMinutes(new Date(t), timeZone) * 60_000;
  return new Date(t);
}

/** The calendar date (YYYY-MM-DD) of an instant in the zone. */
export function zonedDate(instant: Date, timeZone: string = LONDON): string {
  const w = wallClock(instant, timeZone);
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

/** Midnight at the start of the instant's day in the zone, as a UTC instant. */
export function zonedDayStart(instant: Date, timeZone: string = LONDON): Date {
  const w = wallClock(instant, timeZone);
  return zonedTime(w.y, w.m, w.d, 0, 0, timeZone);
}

/** Midnight at the start of the next day in the zone, as a UTC instant. */
export function nextZonedDayStart(instant: Date, timeZone: string = LONDON): Date {
  const w = wallClock(instant, timeZone);
  const next = new Date(Date.UTC(w.y, w.m - 1, w.d + 1));
  return zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
}
