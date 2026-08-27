/** "Pause until tomorrow" target, in local wall-clock time. */

/**
 * The next occurrence of `morningHour` in local time.
 *
 * If `wallNowMs` is strictly before today's `morningHour`, that is returned;
 * otherwise tomorrow's. Exactly on the hour counts as "not before", so a pause
 * started at 06:00:00 with `morningHour = 6` runs until 06:00 tomorrow.
 */
export function nextMorningWall(wallNowMs: number, morningHour: number): number {
  const now = new Date(wallNowMs);
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    morningHour,
    0,
    0,
    0,
  ).getTime();
  if (today > wallNowMs) return today;
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    morningHour,
    0,
    0,
    0,
  ).getTime();
}
