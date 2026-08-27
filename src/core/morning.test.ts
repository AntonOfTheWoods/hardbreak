/**
 * `nextMorningWall` is deliberately local-time based, so the expectations here
 * are built with the same local-time constructor rather than fixed UTC offsets.
 */

import { describe, expect, test } from 'bun:test';
import { nextMorningWall } from './morning.js';

const localTime = (year: number, month: number, day: number, hour: number, minute = 0): number =>
  new Date(year, month, day, hour, minute, 0, 0).getTime();

describe('nextMorningWall', () => {
  test('returns today when the morning hour has not arrived yet', () => {
    const now = localTime(2026, 7, 27, 2, 30);
    expect(nextMorningWall(now, 6)).toBe(localTime(2026, 7, 27, 6));
  });

  test('returns tomorrow once the morning hour has passed', () => {
    const now = localTime(2026, 7, 27, 22, 15);
    expect(nextMorningWall(now, 6)).toBe(localTime(2026, 7, 28, 6));
  });

  test('exactly on the hour counts as passed', () => {
    const now = localTime(2026, 7, 27, 6);
    expect(nextMorningWall(now, 6)).toBe(localTime(2026, 7, 28, 6));
  });

  test('one millisecond before the hour still counts as today', () => {
    const now = localTime(2026, 7, 27, 6) - 1;
    expect(nextMorningWall(now, 6)).toBe(localTime(2026, 7, 27, 6));
  });

  test('rolls over the end of a month', () => {
    const now = localTime(2026, 6, 31, 23);
    expect(nextMorningWall(now, 6)).toBe(localTime(2026, 7, 1, 6));
  });

  test('rolls over the end of a year', () => {
    const now = localTime(2026, 11, 31, 23);
    expect(nextMorningWall(now, 6)).toBe(localTime(2027, 0, 1, 6));
  });

  test('handles midnight as the morning hour', () => {
    const now = localTime(2026, 7, 27, 0, 1);
    expect(nextMorningWall(now, 0)).toBe(localTime(2026, 7, 28, 0));
  });

  test('always lands within the next twenty-four hours', () => {
    const now = localTime(2026, 7, 27, 13, 37);
    for (let hour = 0; hour < 24; hour++) {
      const next = nextMorningWall(now, hour);
      expect(next).toBeGreaterThan(now);
      expect(next - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      expect(new Date(next).getHours()).toBe(hour);
    }
  });
});
