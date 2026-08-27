/** The fake clock and timers are load-bearing for every other suite. */

import { describe, expect, test } from 'bun:test';
import { createFakeTimers, FakeClock } from './testing.js';

describe('FakeClock', () => {
  test('starts still and only moves when told', () => {
    const clock = new FakeClock(0, 1000);
    expect(clock.now()).toBe(0);
    expect(clock.wallNow()).toBe(1000);
    clock.tick(500);
    expect(clock.now()).toBe(500);
    expect(clock.wallNow()).toBe(1500);
  });

  test('sleep moves wall time only', () => {
    const clock = new FakeClock(0, 1000);
    clock.sleep(60_000);
    expect(clock.now()).toBe(0);
    expect(clock.wallNow()).toBe(61_000);
  });
});

describe('createFakeTimers', () => {
  test('fires due timers in deadline order, with the clock set to the deadline', () => {
    const clock = new FakeClock();
    const timers = createFakeTimers(clock);
    const fired: string[] = [];
    timers.set(300, () => fired.push(`c@${clock.now()}`));
    timers.set(100, () => fired.push(`a@${clock.now()}`));
    timers.set(200, () => fired.push(`b@${clock.now()}`));
    timers.advance(1000);
    expect(fired).toEqual(['a@100', 'b@200', 'c@300']);
    expect(clock.now()).toBe(1000);
    expect(timers.pending).toBe(0);
  });

  test('ties fire in the order they were set', () => {
    const clock = new FakeClock();
    const timers = createFakeTimers(clock);
    const fired: string[] = [];
    timers.set(100, () => fired.push('first'));
    timers.set(100, () => fired.push('second'));
    timers.advance(100);
    expect(fired).toEqual(['first', 'second']);
  });

  test('a timer set from inside a callback can still fire in the same advance', () => {
    const clock = new FakeClock();
    const timers = createFakeTimers(clock);
    const fired: number[] = [];
    timers.set(100, () => {
      fired.push(clock.now());
      timers.set(100, () => fired.push(clock.now()));
    });
    timers.advance(250);
    expect(fired).toEqual([100, 200]);
    expect(clock.now()).toBe(250);
  });

  test('clear stops a timer', () => {
    const clock = new FakeClock();
    const timers = createFakeTimers(clock);
    let fired = false;
    const handle = timers.set(100, () => {
      fired = true;
    });
    timers.clear(handle);
    timers.advance(1000);
    expect(fired).toBe(false);
    expect(timers.pending).toBe(0);
  });

  test('nothing fires early', () => {
    const clock = new FakeClock();
    const timers = createFakeTimers(clock);
    let fired = false;
    timers.set(100, () => {
      fired = true;
    });
    timers.advance(99);
    expect(fired).toBe(false);
    expect(timers.pending).toBe(1);
    timers.advance(1);
    expect(fired).toBe(true);
  });
});
