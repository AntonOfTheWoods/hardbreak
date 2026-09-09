/**
 * GLib-backed implementations of the core ports (architecture §5).
 *
 * This is the only place the core's notion of time and timers is tied to the
 * Shell's main loop. Everything else in `src/core` stays testable under bun.
 */

import GLib from 'gi://GLib';

import type { Clock, Log, TimerHandle, Timers } from '../core/types.js';

/** Monotonic milliseconds from GLib, wall milliseconds from `Date`. */
export function createClock(): Clock {
  return {
    // Microseconds since an arbitrary origin; stops while the machine is
    // suspended, exactly like the GLib timeouts that back every deadline.
    now: () => GLib.get_monotonic_time() / 1000,
    wallNow: () => Date.now(),
  };
}

/**
 * One-shot GLib timeouts. The watchdog gets its own instance at
 * `GLib.PRIORITY_HIGH` to run before other ready sources. It cannot preempt a
 * blocked main loop.
 *
 * A callback that throws is logged rather than allowed to escape into the main
 * loop: GJS would report it and the source's return value would be lost, which
 * is exactly when a timer must still be removed. The core wraps its own
 * callbacks too (`Scheduler.safe`, `Watchdog.guard`); this is the backstop.
 */
export function createTimers(priority: number = GLib.PRIORITY_DEFAULT, log?: Log): Timers {
  return {
    set(ms: number, fn: () => void): TimerHandle {
      const delay = Math.max(0, Math.round(ms));
      return GLib.timeout_add(priority, delay, () => {
        try {
          fn();
        } catch (err) {
          log?.('hardbreak: a timer callback threw', err);
        }
        return GLib.SOURCE_REMOVE;
      }) as TimerHandle;
    },
    clear(handle: TimerHandle): void {
      GLib.Source.remove(handle);
    },
  };
}

/** `logError` gives a backtrace in the journal; plain values go to `console`. */
export function createLog(): Log {
  return (msg: string, err?: unknown) => {
    if (err instanceof Error) logError(err, msg);
    else if (err === undefined) console.error(msg);
    else console.error(msg, err);
  };
}
