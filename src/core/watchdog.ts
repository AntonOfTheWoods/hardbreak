/**
 * The watchdog: the only safety net in a Hard enforcer.
 *
 * Enforcement is undismissable by design (spec §2), so every path that touches
 * the Shell during a break runs under an independent deadline and an exception
 * guard. If anything at all goes wrong, `onFire` releases the modal — the user
 * never has to find an escape chord, because there isn't one.
 */

import type { Log, TimerHandle, Timers } from './types.js';

/** Break duration plus this margin is the hard release deadline (spec §2). */
export const WATCHDOG_MARGIN_MS = 30_000;

export class Watchdog {
  private handle: TimerHandle | null = null;
  /** Guards `fire` so a cascade of failures still releases exactly once. */
  private fired = false;

  constructor(
    private readonly timers: Timers,
    private readonly onFire: (reason: string) => void,
    private readonly log: Log,
  ) {}

  /** Whether a deadline is currently pending. */
  get armed(): boolean {
    return this.handle !== null;
  }

  /** Arm (or re-arm, replacing any previous deadline) for `ms` from now. */
  arm(ms: number): void {
    this.disarm();
    this.fired = false;
    this.handle = this.timers.set(Math.max(0, ms), () => {
      this.handle = null;
      this.fire(`deadline of ${Math.max(0, ms)}ms exceeded`);
    });
  }

  /** Cancel the deadline. Safe to call when not armed. */
  disarm(): void {
    if (this.handle === null) return;
    const handle = this.handle;
    this.handle = null;
    try {
      this.timers.clear(handle);
    } catch (err) {
      this.log('hardbreak: watchdog failed to clear its timer', err);
    }
  }

  /**
   * Run `fn`, returning its value. On any throw: log it and fire, because a
   * failure anywhere in the break path may have left the modal grabbed.
   */
  guard<T>(label: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.log(`hardbreak: exception in ${label}`, err);
      this.fire(`exception in ${label}`);
      return undefined;
    }
  }

  /** At most once per `arm()`. */
  private fire(reason: string): void {
    if (this.fired) return;
    this.fired = true;
    this.disarm();
    try {
      this.onFire(reason);
    } catch (err) {
      this.log('hardbreak: watchdog release itself threw', err);
    }
  }
}
