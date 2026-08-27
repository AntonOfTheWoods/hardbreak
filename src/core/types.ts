/**
 * Ports and value types shared by the GJS-free core.
 *
 * Nothing in `src/core` may import `gi://` or `resource:///`: the whole point is
 * that `bun test` can exercise the scheduler and the watchdog without a Shell.
 */

/** Time source. `now()` is monotonic, `wallNow()` is epoch milliseconds. */
export interface Clock {
  /** Monotonic milliseconds. Stops during suspend, exactly like GLib timeouts. */
  now(): number;
  /** Epoch milliseconds. Only used for "pause until tomorrow" and away durations. */
  wallNow(): number;
}

/** Opaque handle returned by {@link Timers.set}. */
export type TimerHandle = number & { readonly __brand: 'TimerHandle' };

/** One-shot timer source (GLib timeouts in the Shell, virtual time in tests). */
export interface Timers {
  set(ms: number, fn: () => void): TimerHandle;
  clear(handle: TimerHandle): void;
}

export type BreakKind = 'mini' | 'long';

/**
 * Why a break stopped. `'skipped'` is the soft-mode Skip button (or Escape);
 * strict mode never produces it, because the overlay offers neither.
 */
export type BreakEndReason = 'completed' | 'postponed' | 'interrupted' | 'aborted' | 'skipped';

/** Everything the overlay needs to put a break on screen. */
export interface BreakRequest {
  kind: BreakKind;
  durationMs: number;
  /** Whether the postpone button should exist at all for this break. */
  postponeAllowed: boolean;
  /** How long after the break start the postpone button stays usable. */
  postponeWindowMs: number;
}

/** Side effects the scheduler drives. Implemented in the Shell by `breakController`. */
export interface SchedulerEffects {
  warn(kind: BreakKind, secondsUntil: number): void;
  startBreak(request: BreakRequest): void;
  /** `'completed'` is the only reason that plays the end sound. */
  endBreak(reason: BreakEndReason): void;
  /** Indicator refresh. Emitted on transitions only, never per second. */
  stateChanged(snapshot: Snapshot): void;
}

export type Mode = 'disabled' | 'dnd' | 'away' | 'paused' | 'countdown' | 'warning' | 'break';

export interface Snapshot {
  mode: Mode;
  /** The kind of the next (or currently running) break. */
  nextKind: BreakKind;
  /** Monotonic milliseconds, or `null` when no break is scheduled. */
  nextBreakAt: number | null;
  /** Epoch milliseconds a pause runs until, or `null` when not paused. */
  pausedUntilWall: number | null;
  minisSinceLong: number;
}

/** The millisecond / fraction form of the first eleven GSettings keys. */
export interface ScheduleSettings {
  miniIntervalMs: number;
  miniDurationMs: number;
  longDurationMs: number;
  minisPerLong: number;
  miniWarningMs: number;
  longWarningMs: number;
  miniPostponeMs: number;
  longPostponeMs: number;
  /** Fraction of the break during which postpone is offered, 0..1. */
  postponeWindow: number;
  idleResetMs: number;
  morningHour: number;
}

/** Diagnostics sink. `err` is whatever was thrown, if anything. */
export type Log = (msg: string, err?: unknown) => void;

export interface LongIdea {
  title: string;
  body: string;
}

/** Contents of `assets/ideas.json`. */
export interface IdeaBook {
  mini: string[];
  long: LongIdea[];
}

/** One idea as shown on the overlay. Mini breaks have no title. */
export interface Idea {
  title?: string;
  body: string;
}
