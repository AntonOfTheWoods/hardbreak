/** Countdown formatting. Pure, so the overlay tick stays trivial. */

/**
 * Format a remaining duration as `m:ss`, rounded up to the next whole second so
 * a fresh 3-minute break reads "3:00" rather than "2:59".
 */
export function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
