/**
 * Virtual time for the unit tests. Ships with the extension (a few hundred
 * bytes of dead code in `dist/`) rather than living outside `src/`, so the
 * tsconfig that type-checks the core covers it too.
 */

import type { Clock, TimerHandle, Timers } from './types.js';

/** Monotonic and wall clocks that only move when a test moves them. */
export class FakeClock implements Clock {
  constructor(
    private monotonic = 0,
    private wall = Date.UTC(2026, 0, 1, 9, 0, 0),
  ) {}

  now(): number {
    return this.monotonic;
  }

  wallNow(): number {
    return this.wall;
  }

  /** Move both clocks forward by `ms`. Used by {@link createFakeTimers}. */
  tick(ms: number): void {
    this.monotonic += ms;
    this.wall += ms;
  }

  /**
   * Model a suspend: wall time passes but the monotonic clock does not, so no
   * timer becomes due. This is what actually happens to a laptop lid, and it is
   * the only way an absence can be longer than a break that is still running.
   */
  sleep(wallMs: number): void {
    this.wall += wallMs;
  }
}

interface Scheduled {
  at: number;
  seq: number;
  fn: () => void;
}

export interface FakeTimers extends Timers {
  /** Advance virtual time by `ms`, firing every timer that comes due, in order. */
  advance(ms: number): void;
  /** How many timers are still pending. */
  readonly pending: number;
}

/** A {@link Timers} implementation driven by `advance()` instead of a main loop. */
export function createFakeTimers(clock: FakeClock): FakeTimers {
  const scheduled = new Map<number, Scheduled>();
  let nextId = 1;
  let seq = 0;

  const nextDue = (limit: number): Scheduled | undefined => {
    let best: Scheduled | undefined;
    let bestId = 0;
    for (const [id, entry] of scheduled) {
      if (entry.at > limit) continue;
      if (
        best === undefined ||
        entry.at < best.at ||
        (entry.at === best.at && entry.seq < best.seq)
      ) {
        best = entry;
        bestId = id;
      }
    }
    if (best !== undefined) scheduled.delete(bestId);
    return best;
  };

  return {
    set(ms: number, fn: () => void): TimerHandle {
      const id = nextId++;
      scheduled.set(id, { at: clock.now() + Math.max(0, ms), seq: seq++, fn });
      return id as TimerHandle;
    },
    clear(handle: TimerHandle): void {
      scheduled.delete(handle);
    },
    advance(ms: number): void {
      const target = clock.now() + ms;
      for (;;) {
        const due = nextDue(target);
        if (due === undefined) break;
        clock.tick(Math.max(0, due.at - clock.now()));
        due.fn();
      }
      clock.tick(Math.max(0, target - clock.now()));
    },
    get pending(): number {
      return scheduled.size;
    },
  };
}
