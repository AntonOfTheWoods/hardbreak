/**
 * Watchdog tests. This is the only thing standing between a bug in the overlay
 * and a locked-up session, so the cases here are deliberately paranoid.
 */

import { describe, expect, test } from 'bun:test';
import { WATCHDOG_MARGIN_MS, Watchdog } from './watchdog.js';
import { createFakeTimers, FakeClock } from './testing.js';
import type { TimerHandle, Timers } from './types.js';

function setup(): {
  watchdog: Watchdog;
  timers: ReturnType<typeof createFakeTimers>;
  fires: string[];
  logs: { msg: string; err: unknown }[];
} {
  const clock = new FakeClock();
  const timers = createFakeTimers(clock);
  const fires: string[] = [];
  const logs: { msg: string; err: unknown }[] = [];
  const watchdog = new Watchdog(
    timers,
    (reason) => fires.push(reason),
    (msg, err) => logs.push({ msg, err }),
  );
  return { watchdog, timers, fires, logs };
}

describe('the deadline', () => {
  test('fires exactly once per arm', () => {
    const { watchdog, timers, fires } = setup();
    watchdog.arm(1000);
    expect(watchdog.armed).toBe(true);
    timers.advance(999);
    expect(fires).toEqual([]);
    timers.advance(1);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toContain('1000ms');
    timers.advance(10_000);
    expect(fires).toHaveLength(1);
    expect(watchdog.armed).toBe(false);
  });

  test('disarm prevents it from firing and drops the timer', () => {
    const { watchdog, timers, fires } = setup();
    watchdog.arm(1000);
    watchdog.disarm();
    expect(watchdog.armed).toBe(false);
    expect(timers.pending).toBe(0);
    timers.advance(10_000);
    expect(fires).toEqual([]);
  });

  test('disarm is safe when nothing is armed', () => {
    const { watchdog, logs } = setup();
    expect(() => {
      watchdog.disarm();
      watchdog.disarm();
    }).not.toThrow();
    expect(logs).toEqual([]);
  });

  test('re-arming replaces the previous deadline', () => {
    const { watchdog, timers, fires } = setup();
    watchdog.arm(1000);
    watchdog.arm(5000);
    expect(timers.pending).toBe(1);
    timers.advance(4999);
    expect(fires).toEqual([]);
    timers.advance(1);
    expect(fires).toHaveLength(1);
  });

  test('re-arming after a fire allows it to fire again', () => {
    const { watchdog, timers, fires } = setup();
    watchdog.arm(1000);
    timers.advance(1000);
    watchdog.arm(1000);
    timers.advance(1000);
    expect(fires).toHaveLength(2);
  });

  test('a negative deadline is clamped rather than rejected', () => {
    const { watchdog, timers, fires } = setup();
    watchdog.arm(-1);
    timers.advance(0);
    expect(fires).toHaveLength(1);
  });

  test('the margin is the constant the spec fixed', () => {
    expect(WATCHDOG_MARGIN_MS).toBe(30_000);
  });
});

describe('guard', () => {
  test('returns the value of a call that succeeds', () => {
    const { watchdog, fires } = setup();
    expect(watchdog.guard('countdown tick', () => 42)).toBe(42);
    expect(fires).toEqual([]);
  });

  test('logs and fires when the call throws', () => {
    const { watchdog, fires, logs } = setup();
    watchdog.arm(60_000);
    const result = watchdog.guard('pushModal', () => {
      throw new Error('grab refused');
    });
    expect(result).toBeUndefined();
    expect(fires).toEqual(['exception in pushModal']);
    expect(logs).toHaveLength(1);
    const logged = logs[0];
    expect(logged?.msg).toContain('pushModal');
    expect((logged?.err as Error | undefined)?.message).toBe('grab refused');
  });

  test('disarms the deadline when it fires', () => {
    const { watchdog, timers, fires } = setup();
    watchdog.arm(60_000);
    watchdog.guard('overlay', () => {
      throw new Error('boom');
    });
    expect(watchdog.armed).toBe(false);
    expect(timers.pending).toBe(0);
    timers.advance(120_000);
    expect(fires).toHaveLength(1);
  });

  test('fires at most once however many calls throw', () => {
    const { watchdog, fires, logs } = setup();
    watchdog.arm(60_000);
    for (const label of ['a', 'b', 'c']) {
      watchdog.guard(label, () => {
        throw new Error(label);
      });
    }
    expect(fires).toEqual(['exception in a']);
    expect(logs).toHaveLength(3);
  });

  test('fires even when the watchdog was never armed', () => {
    const { watchdog, fires } = setup();
    watchdog.guard('teardown', () => {
      throw new Error('boom');
    });
    expect(fires).toEqual(['exception in teardown']);
  });

  test('a fire after the deadline already fired is suppressed', () => {
    const { watchdog, timers, fires } = setup();
    watchdog.arm(1000);
    timers.advance(1000);
    watchdog.guard('teardown', () => {
      throw new Error('boom');
    });
    expect(fires).toHaveLength(1);
  });
});

describe('failures inside the watchdog itself', () => {
  test('a release handler that throws is logged, not propagated', () => {
    const clock = new FakeClock();
    const timers = createFakeTimers(clock);
    const logs: { msg: string; err: unknown }[] = [];
    const watchdog = new Watchdog(
      timers,
      () => {
        throw new Error('release exploded');
      },
      (msg, err) => logs.push({ msg, err }),
    );
    watchdog.arm(1000);
    expect(() => timers.advance(1000)).not.toThrow();
    expect(logs).toHaveLength(1);
  });

  test('a timer source that refuses to clear is logged, not propagated', () => {
    const logs: { msg: string; err: unknown }[] = [];
    const timers: Timers = {
      set: () => 1 as TimerHandle,
      clear: () => {
        throw new Error('no such source');
      },
    };
    const watchdog = new Watchdog(
      timers,
      () => {},
      (msg, err) => logs.push({ msg, err }),
    );
    watchdog.arm(1000);
    expect(() => watchdog.disarm()).not.toThrow();
    expect(watchdog.armed).toBe(false);
    expect(logs).toHaveLength(1);
  });
});
