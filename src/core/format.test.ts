import { describe, expect, test } from 'bun:test';
import { formatCountdown } from './format.js';

describe('formatCountdown', () => {
  test('formats whole minutes', () => {
    expect(formatCountdown(180_000)).toBe('3:00');
    expect(formatCountdown(60_000)).toBe('1:00');
  });

  test('pads the seconds', () => {
    expect(formatCountdown(59_000)).toBe('0:59');
    expect(formatCountdown(9000)).toBe('0:09');
    expect(formatCountdown(65_000)).toBe('1:05');
  });

  test('rounds up, so a fresh three-minute break reads 3:00', () => {
    expect(formatCountdown(179_999)).toBe('3:00');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(1001)).toBe('0:02');
  });

  test('clamps at zero', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5000)).toBe('0:00');
  });

  test('does not wrap past an hour', () => {
    expect(formatCountdown(3_600_000)).toBe('60:00');
    expect(formatCountdown(3_661_000)).toBe('61:01');
  });
});
