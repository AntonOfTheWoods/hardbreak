/**
 * Calendar pause, the pure part (spec §3, ADR 0001, `CONTEXT.md`).
 *
 * The Shell adapter turns the timed events of the watched calendars into busy
 * intervals; everything here is the time arithmetic the scheduler needs on top
 * of them. Wall time throughout (epoch milliseconds): a busy event is a moment
 * on the calendar, not a stretch of the monotonic clock.
 */

/** One busy event, or several merged, as epoch milliseconds: `[startWall, endWall)`. */
export interface BusyInterval {
  startWall: number;
  endWall: number;
}

/**
 * The fixed part of a lead shadow: a break must finish this long before a
 * busy event begins. A constant, not a setting (spec §3).
 */
export const LEAD_SHADOW_MARGIN_MS = 60_000;

/**
 * The calendar gate at one moment.
 *
 * - `none`: no busy event and no lead shadow; breaks run normally.
 * - `shadow`: inside the lead shadow of the busy event starting at
 *   `busyStartWall` — no break may start.
 * - `busy`: inside a busy event. `busyUntilWall` is when the whole hold ends:
 *   chained events and shadows count as one continuous hold, so this is the
 *   moment breaks resume, which may be later than the current event's end.
 */
export type CalendarGate =
  | { state: 'none' }
  | { state: 'shadow'; busyStartWall: number }
  | { state: 'busy'; busyUntilWall: number };

/**
 * Length of the lead shadow before a busy event, for the kind of break that
 * would come next: its warning, its duration and {@link LEAD_SHADOW_MARGIN_MS}.
 * A break whose warning starts inside the shadow could not finish 60 s before
 * the event begins.
 */
export function leadShadowMs(warningMs: number, durationMs: number): number {
  return Math.max(0, warningMs) + Math.max(0, durationMs) + LEAD_SHADOW_MARGIN_MS;
}

/**
 * Sorted, merged and valid: overlapping or touching intervals become one, and
 * zero-length, inverted or non-finite ones are dropped. The adapter is meant to
 * filter those out already; the core drops them again rather than trust it.
 */
export function normalizeBusyIntervals(intervals: readonly BusyInterval[]): BusyInterval[] {
  const valid = intervals
    .filter(
      (interval) =>
        Number.isFinite(interval.startWall) &&
        Number.isFinite(interval.endWall) &&
        interval.endWall > interval.startWall,
    )
    .map((interval) => ({ startWall: interval.startWall, endWall: interval.endWall }))
    .sort((a, b) => a.startWall - b.startWall || a.endWall - b.endWall);

  const merged: BusyInterval[] = [];
  for (const interval of valid) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.startWall <= last.endWall) {
      last.endWall = Math.max(last.endWall, interval.endWall);
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

/** One continuous hold: busy events plus their lead shadows, chained. */
interface Hold {
  startWall: number;
  endWall: number;
  busy: BusyInterval[];
}

function holds(intervals: readonly BusyInterval[], shadowMs: number): Hold[] {
  const result: Hold[] = [];
  for (const busy of normalizeBusyIntervals(intervals)) {
    const startWall = busy.startWall - Math.max(0, shadowMs);
    const last = result[result.length - 1];
    if (last !== undefined && startWall <= last.endWall) {
      last.endWall = Math.max(last.endWall, busy.endWall);
      last.busy.push(busy);
    } else {
      result.push({ startWall, endWall: busy.endWall, busy: [busy] });
    }
  }
  return result;
}

/**
 * The gate at `wallNow`. Purely time-based: it holds for `wallNow` inside a
 * busy event or its lead shadow, whenever the next break happens to be due.
 * A hold starts inclusively and ends exclusively.
 */
export function calendarGateAt(
  wallNow: number,
  intervals: readonly BusyInterval[],
  shadowMs: number,
): CalendarGate {
  for (const hold of holds(intervals, shadowMs)) {
    if (wallNow < hold.startWall) break;
    if (wallNow >= hold.endWall) continue;
    if (hold.busy.some((busy) => wallNow >= busy.startWall && wallNow < busy.endWall)) {
      return { state: 'busy', busyUntilWall: hold.endWall };
    }
    // Inside a hold but between busy events: the shadow of the next one. The
    // last busy event of a hold ends the hold, so there always is a next one.
    const next = hold.busy.find((busy) => busy.startWall > wallNow);
    return { state: 'shadow', busyStartWall: next?.startWall ?? hold.endWall };
  }
  return { state: 'none' };
}

/**
 * The next wall time after `wallNow` at which {@link calendarGateAt} can
 * return something different — a hold starting, a shadow turning into an
 * event, an event giving way to the next one's shadow, a hold ending — or
 * `null` when nothing is left to change.
 */
export function nextCalendarEdge(
  wallNow: number,
  intervals: readonly BusyInterval[],
  shadowMs: number,
): number | null {
  let next: number | null = null;
  const consider = (edge: number): void => {
    if (edge > wallNow && (next === null || edge < next)) next = edge;
  };
  for (const hold of holds(intervals, shadowMs)) {
    consider(hold.startWall);
    for (const busy of hold.busy) {
      consider(busy.startWall);
      consider(busy.endWall);
    }
  }
  return next;
}
