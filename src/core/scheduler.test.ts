/**
 * Scheduler state-machine tests. Everything runs on virtual time, so a
 * fortnight of breaks costs microseconds and no test depends on wall duration.
 */

import { describe, expect, test } from 'bun:test';
import { Scheduler } from './scheduler.js';
import { createFakeTimers, FakeClock, type FakeTimers } from './testing.js';
import type {
  BreakEndReason,
  BreakKind,
  BreakRequest,
  ScheduleSettings,
  SchedulerEffects,
  Snapshot,
  Timers,
} from './types.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

export function settings(overrides: Partial<ScheduleSettings> = {}): ScheduleSettings {
  return {
    miniIntervalMs: 30 * MINUTE,
    miniDurationMs: 60 * SECOND,
    longDurationMs: 180 * SECOND,
    minisPerLong: 1,
    miniWarningMs: 10 * SECOND,
    longWarningMs: 30 * SECOND,
    miniPostponeMs: 2 * MINUTE,
    longPostponeMs: 5 * MINUTE,
    postponeWindow: 0.3,
    idleResetMs: 5 * MINUTE,
    morningHour: 6,
    ...overrides,
  };
}

export type Event =
  | { type: 'warn'; kind: BreakKind; secondsUntil: number; at: number }
  | ({ type: 'start'; at: number } & BreakRequest)
  | { type: 'end'; reason: BreakEndReason; at: number }
  | { type: 'state'; snapshot: Snapshot; at: number };

export interface Hooks {
  warn?: (() => void) | undefined;
  startBreak?: (() => void) | undefined;
  endBreak?: ((reason: BreakEndReason) => void) | undefined;
  stateChanged?: (() => void) | undefined;
}

export interface Harness {
  clock: FakeClock;
  timers: FakeTimers;
  scheduler: Scheduler;
  events: Event[];
  logs: { msg: string; err: unknown }[];
  hooks: Hooks;
  /** Drop every recorded event; handy right after `start()`. */
  clear(): void;
  /** Only the interesting events, i.e. everything but `stateChanged`. */
  effectEvents(): Event[];
  /** The kinds of the breaks that were started, in order. */
  startedKinds(): BreakKind[];
  /** The reasons breaks ended with, in order. */
  endReasons(): BreakEndReason[];
  modes(): Snapshot['mode'][];
  lastState(): Snapshot;
}

export function makeHarness(overrides: Partial<ScheduleSettings> = {}): Harness {
  const clock = new FakeClock();
  const timers = createFakeTimers(clock);
  const events: Event[] = [];
  const logs: { msg: string; err: unknown }[] = [];
  const hooks: Hooks = {};

  const effects: SchedulerEffects = {
    warn(kind, secondsUntil) {
      events.push({ type: 'warn', kind, secondsUntil, at: clock.now() });
      hooks.warn?.();
    },
    startBreak(request) {
      events.push({ type: 'start', at: clock.now(), ...request });
      hooks.startBreak?.();
    },
    endBreak(reason) {
      events.push({ type: 'end', reason, at: clock.now() });
      hooks.endBreak?.(reason);
    },
    stateChanged(snapshot) {
      events.push({ type: 'state', snapshot, at: clock.now() });
      hooks.stateChanged?.();
    },
  };

  const scheduler = new Scheduler(settings(overrides), effects, clock, timers, (msg, err) =>
    logs.push({ msg, err }),
  );

  return {
    clock,
    timers,
    scheduler,
    events,
    logs,
    hooks,
    clear() {
      events.length = 0;
    },
    effectEvents() {
      return events.filter((event) => event.type !== 'state');
    },
    startedKinds() {
      return events.filter((event) => event.type === 'start').map((event) => event.kind);
    },
    endReasons() {
      return events.filter((event) => event.type === 'end').map((event) => event.reason);
    },
    modes() {
      return events.filter((event) => event.type === 'state').map((event) => event.snapshot.mode);
    },
    lastState() {
      const states = events.filter((event) => event.type === 'state');
      const last = states[states.length - 1];
      if (last === undefined) throw new Error('no state was recorded');
      return last.snapshot;
    },
  };
}

type StartEvent = Extract<Event, { type: 'start' }>;

/** The most recent `startBreak` request. */
function lastStart(h: Harness): StartEvent {
  const starts = h.events.filter((event) => event.type === 'start');
  const last = starts[starts.length - 1];
  if (last === undefined) throw new Error('no break was started');
  return last;
}

/** Wait out one interval, then sit through the whole break it starts. */
function cycle(h: Harness, intervalMs = 30 * MINUTE): BreakKind {
  h.timers.advance(intervalMs);
  const started = lastStart(h);
  h.timers.advance(started.durationMs);
  return started.kind;
}

function started(h: Harness): Harness {
  h.scheduler.start();
  h.clear();
  return h;
}

describe('alternation', () => {
  test('minisPerLong = 1 alternates mini and long', () => {
    const h = started(makeHarness());
    for (let i = 0; i < 4; i++) cycle(h);
    expect(h.startedKinds()).toEqual(['mini', 'long', 'mini', 'long']);
    expect(h.endReasons()).toEqual(['completed', 'completed', 'completed', 'completed']);
  });

  test('minisPerLong = 0 makes every break long', () => {
    const h = started(makeHarness({ minisPerLong: 0 }));
    for (let i = 0; i < 3; i++) cycle(h);
    expect(h.startedKinds()).toEqual(['long', 'long', 'long']);
    expect(lastStart(h).durationMs).toBe(180 * SECOND);
  });

  test('minisPerLong = 2 gives two minis per long', () => {
    const h = started(makeHarness({ minisPerLong: 2 }));
    for (let i = 0; i < 6; i++) cycle(h);
    expect(h.startedKinds()).toEqual(['mini', 'mini', 'long', 'mini', 'mini', 'long']);
  });

  test('minisSinceLong is reported and reset by a long break', () => {
    const h = started(makeHarness({ minisPerLong: 2 }));
    cycle(h);
    expect(h.lastState().minisSinceLong).toBe(1);
    expect(h.lastState().nextKind).toBe('mini');
    cycle(h);
    expect(h.lastState().minisSinceLong).toBe(2);
    expect(h.lastState().nextKind).toBe('long');
    cycle(h);
    expect(h.lastState().minisSinceLong).toBe(0);
    expect(h.lastState().nextKind).toBe('mini');
  });
});

describe('warning', () => {
  test('fires exactly warningMs before the break', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE - 10 * SECOND - 1);
    expect(h.effectEvents()).toEqual([]);
    h.timers.advance(1);
    expect(h.effectEvents()).toEqual([
      { type: 'warn', kind: 'mini', secondsUntil: 10, at: 30 * MINUTE - 10 * SECOND },
    ]);
    expect(h.lastState().mode).toBe('warning');
  });

  test('a long break uses the long warning', () => {
    const h = started(makeHarness({ minisPerLong: 0 }));
    h.timers.advance(30 * MINUTE - 30 * SECOND);
    expect(h.effectEvents()).toEqual([
      { type: 'warn', kind: 'long', secondsUntil: 30, at: 30 * MINUTE - 30 * SECOND },
    ]);
  });

  test('a warning of zero means no warning at all', () => {
    const h = started(makeHarness({ miniWarningMs: 0 }));
    h.timers.advance(30 * MINUTE);
    expect(h.events.filter((event) => event.type === 'warn')).toEqual([]);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('re-arming with less than the warning left does not warn twice', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE - 5 * SECOND); // the warning has already fired
    expect(h.events.filter((event) => event.type === 'warn')).toHaveLength(1);
    h.scheduler.wentAway();
    h.timers.advance(MINUTE);
    h.scheduler.cameBack(MINUTE);
    h.timers.advance(5 * SECOND);
    expect(h.events.filter((event) => event.type === 'warn')).toHaveLength(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('re-arming with more than the warning left warns again', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE - 15 * SECOND);
    expect(h.events.filter((event) => event.type === 'warn')).toHaveLength(0);
    h.scheduler.wentAway();
    h.scheduler.cameBack(MINUTE);
    h.timers.advance(5 * SECOND);
    expect(h.events.filter((event) => event.type === 'warn')).toHaveLength(1);
  });
});

describe('break lifecycle', () => {
  test('the break ends after its duration and the next cycle runs from the end', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    expect(lastStart(h)).toEqual({
      type: 'start',
      at: 30 * MINUTE,
      kind: 'mini',
      durationMs: 60 * SECOND,
      postponeAllowed: true,
      postponeWindowMs: 18 * SECOND,
    });
    expect(h.lastState().nextBreakAt).toBeNull();

    h.timers.advance(60 * SECOND);
    expect(h.endReasons()).toEqual(['completed']);
    expect(h.lastState().nextBreakAt).toBe(31 * MINUTE + 30 * MINUTE);

    h.timers.advance(30 * MINUTE);
    expect(lastStart(h).at).toBe(61 * MINUTE);
  });
});

describe('postpone', () => {
  test('is granted once, inside the window, and brings the same kind back', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.timers.advance(5 * SECOND);
    expect(h.scheduler.postpone()).toBe(true);
    expect(h.endReasons()).toEqual(['postponed']);

    h.timers.advance(2 * MINUTE);
    const again = lastStart(h);
    expect(again.kind).toBe('mini');
    expect(again.postponeAllowed).toBe(false);
    expect(h.scheduler.postpone()).toBe(false);
    expect(h.endReasons()).toEqual(['postponed']);
  });

  test('is refused exactly at the end of the window', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.timers.advance(18 * SECOND - 1);
    expect(h.scheduler.postpone()).toBe(true);

    const h2 = started(makeHarness());
    h2.timers.advance(30 * MINUTE);
    h2.timers.advance(18 * SECOND);
    expect(h2.scheduler.postpone()).toBe(false);
    expect(h2.endReasons()).toEqual([]);
  });

  test('is refused when the postpone amount is zero', () => {
    const h = started(makeHarness({ miniPostponeMs: 0 }));
    h.timers.advance(30 * MINUTE);
    expect(lastStart(h).postponeAllowed).toBe(false);
    expect(h.scheduler.postpone()).toBe(false);
  });

  test('is refused when the postpone window is zero', () => {
    const h = started(makeHarness({ postponeWindow: 0 }));
    h.timers.advance(30 * MINUTE);
    expect(lastStart(h).postponeAllowed).toBe(false);
    expect(h.scheduler.postpone()).toBe(false);
  });

  test('is refused outside a break', () => {
    const h = started(makeHarness());
    expect(h.scheduler.postpone()).toBe(false);
    h.timers.advance(20 * MINUTE);
    expect(h.scheduler.postpone()).toBe(false);
    expect(h.effectEvents()).toEqual([]);
  });

  test('leaves the counters alone', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    expect(h.scheduler.postpone()).toBe(true);
    h.timers.advance(2 * MINUTE); // the same mini comes back
    h.timers.advance(60 * SECOND); // and completes this time
    expect(h.startedKinds()).toEqual(['mini', 'mini']);
    cycle(h);
    expect(h.startedKinds()).toEqual(['mini', 'mini', 'long']);
  });

  test('a long break is postponed by the long amount', () => {
    const h = started(makeHarness({ minisPerLong: 0 }));
    h.timers.advance(30 * MINUTE);
    expect(lastStart(h).postponeWindowMs).toBe(54 * SECOND);
    expect(h.scheduler.postpone()).toBe(true);
    h.timers.advance(5 * MINUTE - 1);
    expect(h.startedKinds()).toEqual(['long']);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['long', 'long']);
  });
});

describe('skip (soft mode)', () => {
  test('ends the break, spends it, and runs the next interval from the skip', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.timers.advance(20 * SECOND);
    expect(h.scheduler.skip()).toBe(true);
    expect(h.endReasons()).toEqual(['skipped']);
    // Spent, not owed: the alternation carries on exactly as after a completion.
    expect(h.lastState().minisSinceLong).toBe(1);
    expect(h.lastState().nextKind).toBe('long');
    expect(h.lastState().nextBreakAt).toBe(30 * MINUTE + 20 * SECOND + 30 * MINUTE);
    expect(h.lastState().mode).toBe('countdown');
    expect(cycle(h)).toBe('long');
  });

  test('is refused outside a break and emits nothing', () => {
    const h = started(makeHarness());
    expect(h.scheduler.skip()).toBe(false);
    h.timers.advance(20 * MINUTE);
    expect(h.scheduler.skip()).toBe(false);
    h.timers.advance(30 * MINUTE - 20 * MINUTE + 60 * SECOND); // through a whole break
    h.clear();
    expect(h.scheduler.skip()).toBe(false);
    expect(h.events).toEqual([]);
  });

  test('is never treated as a completion, and no completion follows it', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    expect(h.scheduler.skip()).toBe(true);
    // The break-end timer is gone with it: sitting out the full duration must
    // not produce the 'completed' that would play the end-of-break sound.
    h.timers.advance(60 * SECOND);
    expect(h.endReasons()).toEqual(['skipped']);
    expect(h.endReasons()).not.toContain('completed');
  });

  test('works on a break that came back from a postponement', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    expect(h.scheduler.postpone()).toBe(true);
    h.timers.advance(2 * MINUTE); // the same mini comes back
    expect(lastStart(h).postponeAllowed).toBe(false);
    expect(h.scheduler.skip()).toBe(true);
    expect(h.endReasons()).toEqual(['postponed', 'skipped']);
    expect(h.lastState().minisSinceLong).toBe(1);
    // The spent postponement is cleared with the break, like any other end.
    h.timers.advance(30 * MINUTE);
    expect(lastStart(h).kind).toBe('long');
    expect(lastStart(h).postponeAllowed).toBe(true);
  });

  test('a skip while DND arrived mid-break ends the break and then sits idle', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.setDnd(true);
    h.timers.advance(10 * SECOND);
    expect(h.scheduler.skip()).toBe(true);
    expect(h.endReasons()).toEqual(['skipped']);
    expect(h.lastState().mode).toBe('dnd');
    expect(h.lastState().nextBreakAt).toBeNull();
    expect(h.timers.pending).toBe(0);
    h.timers.advance(5 * 60 * MINUTE);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('a skip while away mid-break ends the break and arms nothing', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.wentAway(); // the wall is exactly what makes you idle
    h.timers.advance(10 * SECOND);
    expect(h.scheduler.skip()).toBe(true);
    expect(h.endReasons()).toEqual(['skipped']);
    expect(h.lastState().mode).toBe('away');
    expect(h.timers.pending).toBe(0);
    // There is no frozen countdown to resume, so a short return starts a fresh
    // cycle — exactly what a break that *completes* while away already does.
    h.scheduler.cameBack(10 * SECOND);
    expect(h.lastState().mode).toBe('countdown');
    expect(cycle(h)).toBe('mini');
  });
});

describe('away', () => {
  test('a short absence resumes with the frozen remaining time', () => {
    const h = started(makeHarness());
    h.timers.advance(10 * MINUTE);
    h.scheduler.wentAway();
    expect(h.timers.pending).toBe(0);
    expect(h.lastState().mode).toBe('away');
    h.timers.advance(2 * MINUTE);
    h.scheduler.cameBack(2 * MINUTE);
    h.timers.advance(20 * MINUTE - 1);
    expect(h.startedKinds()).toEqual([]);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('an absence of at least idle-reset gives a fresh cycle', () => {
    const h = started(makeHarness());
    h.timers.advance(29 * MINUTE);
    h.scheduler.wentAway();
    h.timers.advance(5 * MINUTE);
    h.scheduler.cameBack(5 * MINUTE);
    h.timers.advance(30 * MINUTE - 1);
    expect(h.startedKinds()).toEqual([]);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('an absence of at least idle-reset during a break interrupts and resets it', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE); // mini break starts
    h.timers.advance(10 * SECOND);
    h.scheduler.wentAway();
    // A suspend: wall time runs on but the monotonic clock (and so the
    // break-end timer) does not, which is the only way an absence can outlast a
    // break that is still running.
    h.clock.sleep(6 * MINUTE);
    h.scheduler.cameBack(6 * MINUTE);
    expect(h.endReasons()).toEqual(['interrupted']);
    // The counters were reset, so the next break is a mini again, not the long
    // that would have followed a completed mini.
    expect(cycle(h)).toBe('mini');
  });

  test('a short absence during a break changes nothing', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.wentAway();
    h.timers.advance(10 * SECOND);
    h.scheduler.cameBack(10 * SECOND);
    expect(h.endReasons()).toEqual([]);
    h.timers.advance(50 * SECOND);
    expect(h.endReasons()).toEqual(['completed']);
    expect(cycle(h)).toBe('long');
  });

  test('a second wentAway does not re-freeze the countdown', () => {
    const h = started(makeHarness());
    h.timers.advance(10 * MINUTE);
    h.scheduler.wentAway();
    h.timers.advance(MINUTE);
    h.scheduler.wentAway();
    h.scheduler.cameBack(MINUTE);
    h.timers.advance(20 * MINUTE);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('cameBack without wentAway is ignored', () => {
    const h = started(makeHarness());
    h.timers.advance(10 * MINUTE);
    h.scheduler.cameBack(10 * MINUTE);
    expect(h.effectEvents()).toEqual([]);
    h.timers.advance(20 * MINUTE);
    expect(h.startedKinds()).toEqual(['mini']);
  });
});

describe('interrupted breaks (lock and suspend)', () => {
  test('a lock during a break interrupts it and a short return brings the same break back', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE); // the mini break starts
    h.timers.advance(10 * SECOND);
    h.scheduler.wentAway({ interruptBreak: true });
    expect(h.endReasons()).toEqual(['interrupted']);
    expect(h.timers.pending).toBe(0); // the break-end timer is gone with it
    // The counters are untouched: the same mini is still owed.
    expect(h.lastState().minisSinceLong).toBe(0);
    expect(h.lastState().nextKind).toBe('mini');

    // A lid closed for a minute: wall time runs on, the monotonic clock does not.
    h.clock.sleep(MINUTE);
    h.scheduler.cameBack(MINUTE);
    h.timers.advance(0); // the warning is due the instant the session is back
    expect(h.events.filter((event) => event.type === 'warn')).toEqual([
      // The warning that led into the interrupted break, and then its repeat.
      { type: 'warn', kind: 'mini', secondsUntil: 10, at: 30 * MINUTE - 10 * SECOND },
      { type: 'warn', kind: 'mini', secondsUntil: 10, at: 30 * MINUTE + 10 * SECOND },
    ]);
    h.timers.advance(10 * SECOND);
    expect(h.startedKinds()).toEqual(['mini', 'mini']);

    h.timers.advance(60 * SECOND);
    expect(h.endReasons()).toEqual(['interrupted', 'completed']);
    // Only the break that actually finished moves the alternation on.
    expect(cycle(h)).toBe('long');
  });

  test('an absence past idle-reset after an interruption gives a fresh cycle', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.timers.advance(10 * SECOND);
    h.scheduler.wentAway({ interruptBreak: true });
    h.clock.sleep(6 * MINUTE);
    h.scheduler.cameBack(6 * MINUTE);
    expect(h.endReasons()).toEqual(['interrupted']);
    // Six minutes locked is the break; the cycle starts over from the interval.
    h.timers.advance(30 * MINUTE - 1);
    expect(h.startedKinds()).toEqual(['mini']);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['mini', 'mini']);
  });

  test('going idle during a break still leaves it running', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.wentAway();
    expect(h.endReasons()).toEqual([]);
    h.timers.advance(60 * SECOND);
    expect(h.endReasons()).toEqual(['completed']);
  });

  test('a lock interrupts a break even when the idle watch fired first', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.wentAway(); // the wall is exactly what makes you idle
    h.timers.advance(10 * SECOND);
    expect(h.endReasons()).toEqual([]);
    h.scheduler.wentAway({ interruptBreak: true });
    expect(h.endReasons()).toEqual(['interrupted']);
    expect(h.lastState().mode).toBe('away');
  });

  test('an interruption keeps a postponement spent', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    expect(lastStart(h).postponeAllowed).toBe(true);
    expect(h.scheduler.postpone()).toBe(true);
    h.timers.advance(2 * MINUTE); // the postponed mini comes back
    expect(lastStart(h).postponeAllowed).toBe(false);
    h.scheduler.wentAway({ interruptBreak: true });
    h.scheduler.cameBack(MINUTE);
    h.timers.advance(10 * SECOND); // the warning, then the wall again
    expect(h.startedKinds()).toEqual(['mini', 'mini', 'mini']);
    expect(lastStart(h).postponeAllowed).toBe(false);
  });

  test('with no warning configured the wall comes straight back', () => {
    const h = started(makeHarness({ miniWarningMs: 0 }));
    h.timers.advance(30 * MINUTE);
    h.timers.advance(10 * SECOND);
    h.scheduler.wentAway({ interruptBreak: true });
    h.scheduler.cameBack(30 * SECOND);
    h.timers.advance(0);
    expect(h.startedKinds()).toEqual(['mini', 'mini']);
  });

  test('outside a break the interrupt flag changes nothing', () => {
    const h = started(makeHarness());
    h.timers.advance(10 * MINUTE);
    h.scheduler.wentAway({ interruptBreak: true });
    expect(h.timers.pending).toBe(0);
    expect(h.endReasons()).toEqual([]);
    h.scheduler.cameBack(MINUTE);
    h.timers.advance(20 * MINUTE - 1);
    expect(h.startedKinds()).toEqual([]);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });
});

describe('do not disturb', () => {
  test('freezes everything while it is on and restarts fresh when it goes off', () => {
    const h = started(makeHarness());
    h.timers.advance(29 * MINUTE);
    h.scheduler.setDnd(true);
    expect(h.lastState().mode).toBe('dnd');
    expect(h.timers.pending).toBe(0);
    h.timers.advance(2 * 60 * MINUTE);
    expect(h.effectEvents()).toEqual([]);

    h.scheduler.setDnd(false);
    h.timers.advance(30 * MINUTE - 1);
    expect(h.startedKinds()).toEqual([]);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('a break in progress is allowed to finish', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.setDnd(true);
    h.timers.advance(60 * SECOND);
    expect(h.endReasons()).toEqual(['completed']);
    h.timers.advance(60 * MINUTE);
    expect(h.startedKinds()).toEqual(['mini']);

    // Coming out of DND is a fresh cycle, so the counters start over.
    h.scheduler.setDnd(false);
    expect(cycle(h)).toBe('mini');
  });

  test('setting the same value twice is a no-op', () => {
    const h = started(makeHarness());
    h.scheduler.setDnd(false);
    expect(h.events).toEqual([]);
  });

  for (const action of ['postpone', 'skip'] as const) {
    test(`switched on and off during a break, it leaves the break running: ${action} still works`, () => {
      const h = started(makeHarness());
      h.timers.advance(30 * MINUTE); // the mini starts
      h.timers.advance(5 * SECOND);
      h.scheduler.setDnd(true);
      h.scheduler.setDnd(false);
      expect(h.lastState()).toMatchObject({ mode: 'break', nextBreakAt: null });
      expect(h.timers.pending).toBe(1); // the break end, and nothing armed behind it
      expect(h.scheduler[action]()).toBe(true);
      expect(h.endReasons()).toEqual([action === 'skip' ? 'skipped' : 'postponed']);
      expect(h.lastState().mode).toBe('countdown');
    });
  }

  test('switched on and off during a break, the break end plans the next cycle normally', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.setDnd(true);
    h.scheduler.setDnd(false);
    h.timers.advance(60 * SECOND);
    expect(h.endReasons()).toEqual(['completed']);
    expect(h.lastState()).toMatchObject({ mode: 'countdown', nextKind: 'long' });
    expect(h.lastState().nextBreakAt).toBe(31 * MINUTE + 30 * MINUTE);
    expect(h.timers.pending).toBe(2); // one warning and one break start, not two of each
    expect(cycle(h)).toBe('long');
    expect(h.startedKinds()).toEqual(['mini', 'long']);
  });
});

describe('pause', () => {
  test('pauseFor stops breaks and resumes with a fresh cycle', () => {
    const h = started(makeHarness());
    h.timers.advance(10 * MINUTE);
    h.scheduler.pauseFor(60 * MINUTE);
    expect(h.lastState().mode).toBe('paused');
    expect(h.lastState().nextBreakAt).toBeNull();
    h.timers.advance(60 * MINUTE - 1);
    expect(h.effectEvents()).toEqual([]);
    h.timers.advance(1);
    expect(h.lastState().mode).toBe('countdown');
    h.timers.advance(30 * MINUTE);
    expect(lastStart(h).at).toBe(10 * MINUTE + 60 * MINUTE + 30 * MINUTE);
  });

  test('pauseUntilWall converts wall time to a monotonic deadline', () => {
    const h = started(makeHarness());
    const until = h.clock.wallNow() + 3 * 60 * MINUTE;
    h.scheduler.pauseUntilWall(until);
    expect(h.lastState().pausedUntilWall).toBe(until);
    h.timers.advance(3 * 60 * MINUTE);
    expect(h.lastState().mode).toBe('countdown');
    expect(h.lastState().pausedUntilWall).toBeNull();
  });

  test('pauseUntilWall in the past just resets', () => {
    const h = started(makeHarness());
    h.timers.advance(20 * MINUTE);
    h.scheduler.pauseUntilWall(h.clock.wallNow() - 1000);
    expect(h.lastState().mode).toBe('countdown');
    h.timers.advance(30 * MINUTE);
    expect(lastStart(h).at).toBe(50 * MINUTE);
  });

  test('a pause is ignored during a break', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.pauseFor(60 * MINUTE);
    expect(h.lastState().mode).toBe('break');
    h.timers.advance(60 * SECOND);
    expect(h.endReasons()).toEqual(['completed']);
    expect(h.lastState().mode).toBe('countdown');
  });

  test('a pause survives an absence', () => {
    const h = started(makeHarness());
    h.scheduler.pauseFor(60 * MINUTE);
    h.scheduler.wentAway();
    h.timers.advance(10 * MINUTE);
    h.scheduler.cameBack(10 * MINUTE);
    expect(h.lastState().mode).toBe('paused');
    h.timers.advance(50 * MINUTE);
    expect(h.lastState().mode).toBe('countdown');
  });

  test('reset clears a pause and restarts the interval', () => {
    const h = started(makeHarness());
    h.scheduler.pauseFor(2 * 60 * MINUTE);
    h.scheduler.reset();
    expect(h.lastState().mode).toBe('countdown');
    expect(h.lastState().pausedUntilWall).toBeNull();
    h.timers.advance(30 * MINUTE);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('reset while counting down restarts the wait', () => {
    const h = started(makeHarness());
    h.timers.advance(20 * MINUTE);
    h.scheduler.reset();
    h.timers.advance(20 * MINUTE);
    expect(h.startedKinds()).toEqual([]);
    h.timers.advance(10 * MINUTE);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('reset does not touch a running break', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.reset();
    expect(h.lastState().mode).toBe('break');
    h.timers.advance(60 * SECOND);
    expect(h.endReasons()).toEqual(['completed']);
  });
});

describe('enable and disable', () => {
  test('disabling cancels everything and ends a running break as interrupted', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.setEnabled(false);
    expect(h.endReasons()).toEqual(['interrupted']);
    expect(h.lastState().mode).toBe('disabled');
    expect(h.timers.pending).toBe(0);
    h.timers.advance(5 * 60 * MINUTE);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('disabling while counting down stops the breaks', () => {
    const h = started(makeHarness());
    h.timers.advance(10 * MINUTE);
    h.scheduler.setEnabled(false);
    h.timers.advance(5 * 60 * MINUTE);
    expect(h.effectEvents()).toEqual([]);
  });

  test('enabling starts a fresh cycle', () => {
    const h = started(makeHarness());
    h.scheduler.setEnabled(false);
    h.timers.advance(60 * MINUTE);
    h.scheduler.setEnabled(true);
    expect(h.lastState().mode).toBe('countdown');
    h.timers.advance(30 * MINUTE - 1);
    expect(h.startedKinds()).toEqual([]);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('stop cancels every timer', () => {
    const h = started(makeHarness());
    h.timers.advance(10 * MINUTE);
    h.scheduler.stop();
    expect(h.timers.pending).toBe(0);
    expect(h.lastState().mode).toBe('disabled');
    h.timers.advance(5 * 60 * MINUTE);
    expect(h.effectEvents()).toEqual([]);
  });
});

describe('updateSettings', () => {
  test('re-plans the current wait from when the cycle started', () => {
    const h = started(makeHarness());
    h.timers.advance(10 * MINUTE);
    h.scheduler.updateSettings(settings({ miniIntervalMs: 20 * MINUTE }));
    expect(h.lastState().nextBreakAt).toBe(20 * MINUTE);
    h.timers.advance(10 * MINUTE - 1);
    expect(h.startedKinds()).toEqual([]);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('never fires instantly when the new interval is already past', () => {
    const h = started(makeHarness());
    h.timers.advance(25 * MINUTE);
    h.scheduler.updateSettings(settings({ miniIntervalMs: 10 * MINUTE }));
    expect(h.lastState().nextBreakAt).toBe(25 * MINUTE + SECOND);
    h.timers.advance(SECOND - 1);
    expect(h.startedKinds()).toEqual([]);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('never touches a running break', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.updateSettings(settings({ miniDurationMs: 5 * SECOND, miniIntervalMs: MINUTE }));
    h.timers.advance(5 * SECOND);
    expect(h.endReasons()).toEqual([]);
    expect(h.lastState().mode).toBe('break');
    h.timers.advance(55 * SECOND);
    expect(h.endReasons()).toEqual(['completed']);
    // The new interval only applies to the cycle that follows the break.
    h.timers.advance(MINUTE);
    expect(h.startedKinds()).toEqual(['mini', 'long']);
  });

  test('a longer warning takes effect on the current wait', () => {
    const h = started(makeHarness());
    h.timers.advance(MINUTE);
    h.scheduler.updateSettings(settings({ miniWarningMs: 60 * SECOND }));
    h.timers.advance(29 * MINUTE - 60 * SECOND);
    expect(h.effectEvents()).toEqual([
      { type: 'warn', kind: 'mini', secondsUntil: 60, at: 29 * MINUTE },
    ]);
  });
});

describe('abortBreak', () => {
  test('ends the break and advances the counters like a completion', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.timers.advance(20 * SECOND);
    h.scheduler.abortBreak();
    expect(h.endReasons()).toEqual(['aborted']);
    expect(h.lastState().minisSinceLong).toBe(1);
    expect(cycle(h)).toBe('long');
  });

  test('is a no-op outside a break', () => {
    const h = started(makeHarness());
    h.timers.advance(10 * MINUTE);
    h.scheduler.abortBreak();
    expect(h.events).toEqual([]);
    h.timers.advance(20 * MINUTE);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('cancels the break-end timer so no completion follows', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE);
    h.scheduler.abortBreak();
    h.timers.advance(60 * SECOND);
    expect(h.endReasons()).toEqual(['aborted']);
  });
});

describe('snapshots', () => {
  test('report each mode transition once', () => {
    const h = started(makeHarness());
    h.timers.advance(30 * MINUTE - 10 * SECOND);
    h.timers.advance(10 * SECOND);
    h.timers.advance(60 * SECOND);
    expect(h.modes()).toEqual(['warning', 'break', 'countdown']);
  });

  test('nothing at all is emitted between transitions', () => {
    const h = started(makeHarness());
    h.timers.advance(29 * MINUTE);
    expect(h.events).toEqual([]);
    h.timers.advance(50 * SECOND); // the warning
    expect(h.events).toHaveLength(2);
    h.timers.advance(9 * SECOND);
    expect(h.events).toHaveLength(2);
  });

  test('nextBreakAt is null during a break and while paused', () => {
    const h = started(makeHarness());
    expect(h.scheduler.snapshot().nextBreakAt).toBe(30 * MINUTE);
    h.timers.advance(30 * MINUTE);
    expect(h.scheduler.snapshot().nextBreakAt).toBeNull();
    h.timers.advance(60 * SECOND);
    h.scheduler.pauseFor(MINUTE);
    expect(h.scheduler.snapshot().nextBreakAt).toBeNull();
  });

  test('a scheduler that was never started reports disabled', () => {
    const h = makeHarness();
    expect(h.scheduler.snapshot()).toEqual({
      mode: 'disabled',
      nextKind: 'mini',
      nextBreakAt: null,
      pausedUntilWall: null,
      minisSinceLong: 0,
      busyUntilWall: null,
      busyStartsWall: null,
    });
  });
});

describe('failing effects', () => {
  test('a throwing warn is logged and the break still happens', () => {
    const h = started(makeHarness());
    h.hooks.warn = () => {
      throw new Error('notification exploded');
    };
    expect(() => h.timers.advance(30 * MINUTE)).not.toThrow();
    expect(h.logs).toHaveLength(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('a throwing startBreak becomes an abort', () => {
    const h = started(makeHarness());
    h.hooks.startBreak = () => {
      throw new Error('overlay exploded');
    };
    expect(() => h.timers.advance(30 * MINUTE)).not.toThrow();
    expect(h.endReasons()).toEqual(['aborted']);
    expect(h.logs.length).toBeGreaterThanOrEqual(1);
    // And the schedule survives: the next cycle is armed and alternates on.
    h.hooks.startBreak = undefined;
    expect(cycle(h)).toBe('long');
  });

  test('a throwing endBreak is logged and still releases the break', () => {
    const h = started(makeHarness());
    h.hooks.endBreak = (reason) => {
      if (reason === 'completed') throw new Error('teardown exploded');
    };
    h.timers.advance(30 * MINUTE);
    expect(() => h.timers.advance(60 * SECOND)).not.toThrow();
    expect(h.endReasons()).toEqual(['completed', 'aborted']);
    expect(h.logs.length).toBeGreaterThanOrEqual(1);
    h.hooks.endBreak = undefined;
    expect(cycle(h)).toBe('long');
  });

  test('a throwing stateChanged never escapes a timer callback', () => {
    const h = started(makeHarness());
    h.hooks.stateChanged = () => {
      throw new Error('indicator exploded');
    };
    expect(() => h.timers.advance(30 * MINUTE)).not.toThrow();
    expect(h.endReasons()).toEqual(['aborted']);
    expect(h.logs.length).toBeGreaterThanOrEqual(2);
  });

  test('a timer callback that throws outside a break does not abort anything', () => {
    const h = started(makeHarness());
    h.hooks.stateChanged = () => {
      throw new Error('indicator exploded');
    };
    expect(() => h.timers.advance(30 * MINUTE - 10 * SECOND)).not.toThrow();
    expect(h.endReasons()).toEqual([]);
    expect(h.logs).toHaveLength(1);
  });
});

describe('suspend', () => {
  test('an idle-reset absence during a break interrupts it without a suspend too', () => {
    const h = started(makeHarness({ idleResetMs: 30 * SECOND }));
    h.timers.advance(30 * MINUTE);
    h.timers.advance(10 * SECOND);
    h.scheduler.wentAway();
    h.timers.advance(40 * SECOND); // still inside the 60 s break
    h.scheduler.cameBack(40 * SECOND);
    expect(h.endReasons()).toEqual(['interrupted']);
    expect(h.lastState().minisSinceLong).toBe(0);
    h.timers.advance(10 * SECOND);
    expect(h.endReasons()).toEqual(['interrupted']); // the break-end timer is gone
  });

  test('a suspend does not consume the countdown', () => {
    const h = started(makeHarness());
    h.timers.advance(10 * MINUTE);
    h.scheduler.wentAway();
    h.clock.sleep(8 * 60 * MINUTE);
    h.scheduler.cameBack(8 * 60 * MINUTE);
    // Eight hours away is far beyond idle-reset, so the cycle starts over.
    h.timers.advance(30 * MINUTE - 1);
    expect(h.startedKinds()).toEqual([]);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });
});

describe('timer hygiene', () => {
  /**
   * Real GLib logs a critical when a source id is removed after its callback
   * has already run, so a handle must be forgotten the moment it fires. The
   * fake timers are forgiving, hence this bookkeeping wrapper.
   */
  function trackingTimers(clock: FakeClock): {
    timers: Timers;
    advance: (ms: number) => void;
    staleClears: number[];
  } {
    const inner = createFakeTimers(clock);
    const live = new Set<number>();
    const staleClears: number[] = [];
    const timers: Timers = {
      set(ms, fn) {
        const handle = inner.set(ms, () => {
          live.delete(handle);
          fn();
        });
        live.add(handle);
        return handle;
      },
      clear(handle) {
        if (!live.delete(handle)) staleClears.push(handle);
        inner.clear(handle);
      },
    };
    return { timers, advance: (ms) => inner.advance(ms), staleClears };
  }

  const silentEffects: SchedulerEffects = {
    warn() {},
    startBreak() {},
    endBreak() {},
    stateChanged() {},
  };

  test('no timer is cleared after it has fired', () => {
    const clock = new FakeClock();
    const { timers, advance, staleClears } = trackingTimers(clock);
    const scheduler = new Scheduler(settings(), silentEffects, clock, timers, () => {});

    scheduler.start();
    scheduler.pauseFor(MINUTE);
    advance(MINUTE); // the pause-end timer fires
    scheduler.reset(); // used to clear the dead pause-end handle
    advance(30 * MINUTE); // warning, break start
    advance(60 * SECOND); // break end
    scheduler.stop();

    expect(staleClears).toEqual([]);
  });

  test('the calendar edge timer is never cleared after it has fired either', () => {
    const clock = new FakeClock();
    const { timers, advance, staleClears } = trackingTimers(clock);
    const scheduler = new Scheduler(settings(), silentEffects, clock, timers, () => {});
    const nine = clock.wallNow();

    scheduler.start();
    scheduler.setBusyIntervals([
      { startWall: nine + 10 * MINUTE, endWall: nine + 20 * MINUTE },
      { startWall: nine + 40 * MINUTE, endWall: nine + 50 * MINUTE },
    ]);
    advance(15 * MINUTE); // shadow start, event start
    scheduler.setBusyIntervals([{ startWall: nine + 40 * MINUTE, endWall: nine + 50 * MINUTE }]);
    advance(60 * MINUTE); // shadow, event, end, and a break
    scheduler.stop();

    expect(staleClears).toEqual([]);
  });
});

describe('calendar pause', () => {
  /** Wall time on the fake clock's day (it starts at 09:00 UTC). */
  function wall(hours: number, minutes = 0, seconds = 0): number {
    return Date.UTC(2026, 0, 1, hours, minutes, seconds);
  }

  function advanceTo(h: Harness, wallMs: number): void {
    h.timers.advance(wallMs - h.clock.wallNow());
  }

  function event(start: number, end: number): { startWall: number; endWall: number } {
    return { startWall: start, endWall: end };
  }

  const MINI_SHADOW = 10 * SECOND + 60 * SECOND + 60 * SECOND;
  const LONG_SHADOW = 30 * SECOND + 180 * SECOND + 60 * SECOND;

  test('a busy event stops the countdown like DND, and its end is a fresh cycle', () => {
    const h = started(makeHarness());
    h.scheduler.setBusyIntervals([event(wall(9, 10), wall(9, 20))]);
    expect(h.lastState().mode).toBe('countdown');

    advanceTo(h, wall(9, 10) - MINI_SHADOW - 1);
    expect(h.lastState().mode).toBe('countdown');
    h.timers.advance(1);
    expect(h.lastState()).toMatchObject({
      mode: 'calendar',
      nextBreakAt: null,
      busyStartsWall: wall(9, 10),
      busyUntilWall: null,
    });
    expect(h.timers.pending).toBe(1); // the calendar edge, nothing else

    advanceTo(h, wall(9, 10));
    expect(h.lastState()).toMatchObject({
      mode: 'calendar',
      busyStartsWall: null,
      busyUntilWall: wall(9, 20),
    });

    advanceTo(h, wall(9, 20));
    expect(h.lastState().mode).toBe('countdown');
    expect(h.lastState().busyUntilWall).toBeNull();
    expect(h.effectEvents()).toEqual([]);

    // A fresh cycle: the next break is a full interval after the event.
    advanceTo(h, wall(9, 50) - 1);
    expect(h.startedKinds()).toEqual([]);
    h.timers.advance(1);
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('the 09:58 case: a long break that would straddle a 10:00 event never starts', () => {
    // Every break long, the next one due at 09:58 (its warning at 09:57:30).
    const h = started(makeHarness({ minisPerLong: 0, miniIntervalMs: 58 * MINUTE }));
    h.scheduler.setBusyIntervals([event(wall(10), wall(10, 45))]);

    // Silence begins at 10:00 − (30 s warning + 180 s break + 60 s): 09:55:30.
    expect(wall(10) - LONG_SHADOW).toBe(wall(9, 55, 30));
    advanceTo(h, wall(9, 55, 30) - 1);
    expect(h.lastState().mode).toBe('countdown');
    h.timers.advance(1);
    expect(h.lastState()).toMatchObject({ mode: 'calendar', busyStartsWall: wall(10) });

    advanceTo(h, wall(10, 45) - 1);
    expect(h.effectEvents()).toEqual([]);
    h.timers.advance(1);
    expect(h.lastState().mode).toBe('countdown');

    advanceTo(h, wall(11, 43));
    expect(h.events.filter((e) => e.type === 'warn')).toHaveLength(1);
    expect(h.startedKinds()).toEqual(['long']);
  });

  test('a break that finishes more than 60 s before the event still runs, into the shadow', () => {
    // Long break at 09:54, over at 09:57; the shadow of a 10:00 event starts
    // at 09:55:30, while it is running. It is not interrupted.
    const h = started(makeHarness({ minisPerLong: 0, miniIntervalMs: 54 * MINUTE }));
    h.scheduler.setBusyIntervals([event(wall(10), wall(10, 45))]);

    advanceTo(h, wall(9, 54));
    expect(h.startedKinds()).toEqual(['long']);
    advanceTo(h, wall(9, 55, 30));
    expect(h.endReasons()).toEqual([]);
    expect(h.lastState().mode).toBe('calendar');

    advanceTo(h, wall(9, 57));
    expect(h.endReasons()).toEqual(['completed']);
    // No new countdown behind the gate.
    expect(h.lastState()).toMatchObject({ mode: 'calendar', nextBreakAt: null });
    expect(h.timers.pending).toBe(1);

    advanceTo(h, wall(10, 45));
    expect(h.lastState().mode).toBe('countdown');
    expect(h.startedKinds()).toEqual(['long']);
  });

  test('no warning when a shadow begins inside the warning period', () => {
    // Break due 09:55:45, its warning due 09:55:15; the shadow of a 10:00
    // event starts at 09:55:30, in between. The warning would have no break.
    const h = started(makeHarness({ minisPerLong: 0, miniIntervalMs: 55 * MINUTE + 45 * SECOND }));
    h.scheduler.setBusyIntervals([event(wall(10), wall(10, 45))]);
    advanceTo(h, wall(9, 55, 15));
    expect(h.lastState().mode).toBe('countdown');
    advanceTo(h, wall(9, 55, 30));
    expect(h.lastState().mode).toBe('calendar');
    advanceTo(h, wall(10, 45));
    expect(h.events.filter((e) => e.type === 'warn')).toEqual([]);
    expect(h.startedKinds()).toEqual([]);
  });

  test('no warning when the shadow begins exactly as the break is due', () => {
    // Break due 09:55:30, warned at 09:55:00; the shadow starts at 09:55:30.
    const h = started(makeHarness({ minisPerLong: 0, miniIntervalMs: 55 * MINUTE + 30 * SECOND }));
    h.scheduler.setBusyIntervals([event(wall(10), wall(10, 45))]);
    expect(wall(10) - LONG_SHADOW).toBe(wall(9, 55, 30));
    advanceTo(h, wall(9, 55, 30));
    expect(h.lastState().mode).toBe('calendar');
    advanceTo(h, wall(10, 45));
    expect(h.events.filter((e) => e.type === 'warn')).toEqual([]);
    expect(h.startedKinds()).toEqual([]);
  });

  test('a shadow that begins just after the break would end leaves warning and break alone', () => {
    // Break due 09:52, over at 09:55:00; the event at 09:59:31 casts its
    // shadow from 09:55:01.
    const h = started(makeHarness({ minisPerLong: 0, miniIntervalMs: 52 * MINUTE }));
    h.scheduler.setBusyIntervals([event(wall(9, 59, 31), wall(10, 45))]);
    advanceTo(h, wall(9, 51, 30));
    expect(h.effectEvents()).toEqual([
      { type: 'warn', kind: 'long', secondsUntil: 30, at: h.clock.now() },
    ]);
    advanceTo(h, wall(9, 55));
    expect(h.startedKinds()).toEqual(['long']);
    expect(h.endReasons()).toEqual(['completed']);
    advanceTo(h, wall(9, 55, 1));
    expect(h.lastState().mode).toBe('calendar');
  });

  test('the shadow follows the next kind: a mini fits where a long does not', () => {
    // Mini due at 09:56:30 (over at 09:57:30), then the event at 10:00. The
    // mini shadow (130 s) starts at 09:57:50, after the mini is over.
    const mini = started(makeHarness({ miniIntervalMs: 56 * MINUTE + 30 * SECOND }));
    mini.scheduler.setBusyIntervals([event(wall(10), wall(10, 45))]);
    advanceTo(mini, wall(9, 58));
    expect(mini.startedKinds()).toEqual(['mini']);
    expect(mini.endReasons()).toEqual(['completed']);

    // The same slot for a long break: its shadow (270 s) starts at 09:55:30.
    const long = started(
      makeHarness({ minisPerLong: 0, miniIntervalMs: 56 * MINUTE + 30 * SECOND }),
    );
    long.scheduler.setBusyIntervals([event(wall(10), wall(10, 45))]);
    advanceTo(long, wall(9, 58));
    expect(long.startedKinds()).toEqual([]);
  });

  test('a busy event added during a break interrupts it, and it is not owed', () => {
    const h = started(makeHarness());
    advanceTo(h, wall(9, 30)); // the mini starts
    advanceTo(h, wall(9, 30, 20));
    // A late edit from a phone: an event that is already in progress.
    h.scheduler.setBusyIntervals([event(wall(9, 30), wall(10))]);
    expect(h.endReasons()).toEqual(['interrupted']);
    expect(h.lastState()).toMatchObject({ mode: 'calendar', busyUntilWall: wall(10) });
    expect(h.timers.pending).toBe(1); // the break-end timer is gone

    advanceTo(h, wall(9, 32));
    expect(h.endReasons()).toEqual(['interrupted']); // no completion follows

    advanceTo(h, wall(10));
    expect(h.lastState().mode).toBe('countdown');
    // Not owed: no warning replay, and a fresh cycle — the next break is a
    // mini a full interval later, not the long a completed mini would earn.
    expect(h.events.filter((e) => e.type === 'warn')).toHaveLength(1);
    advanceTo(h, wall(10, 30));
    expect(h.startedKinds()).toEqual(['mini', 'mini']);
  });

  test('an event added just ahead of a running break interrupts it when it begins', () => {
    const h = started(makeHarness());
    advanceTo(h, wall(9, 30, 10)); // mini running until 09:31
    h.scheduler.setBusyIntervals([event(wall(9, 30, 40), wall(10))]);
    // Only the shadow holds so far: the break carries on.
    expect(h.endReasons()).toEqual([]);
    expect(h.lastState().mode).toBe('calendar');
    advanceTo(h, wall(9, 30, 40));
    expect(h.endReasons()).toEqual(['interrupted']);
  });

  test('an empty list releases the gate with a fresh cycle', () => {
    const h = started(makeHarness());
    advanceTo(h, wall(9, 20));
    h.scheduler.setBusyIntervals([event(wall(9, 15), wall(11))]);
    expect(h.lastState().mode).toBe('calendar');
    advanceTo(h, wall(9, 40));
    h.scheduler.setBusyIntervals([]);
    expect(h.lastState().mode).toBe('countdown');
    expect(h.lastState().nextBreakAt).toBe(h.clock.now() + 30 * MINUTE);
    expect(h.timers.pending).toBe(2); // warning and break start, no edge
  });

  test('chained events are one continuous hold with no fresh cycle in between', () => {
    const h = started(makeHarness());
    h.scheduler.setBusyIntervals([
      event(wall(9, 10), wall(9, 20)),
      event(wall(9, 21), wall(9, 30)),
    ]);
    h.clear();
    advanceTo(h, wall(9, 15));
    expect(h.lastState().busyUntilWall).toBe(wall(9, 30));
    advanceTo(h, wall(9, 20, 30));
    expect(h.lastState()).toMatchObject({ mode: 'calendar', busyStartsWall: wall(9, 21) });
    advanceTo(h, wall(9, 30));
    expect(h.modes().filter((mode) => mode !== 'calendar')).toEqual(['countdown']);
    expect(h.lastState().nextBreakAt).toBe(h.clock.now() + 30 * MINUTE);
  });

  test('zero-length and inverted intervals are dropped', () => {
    const h = started(makeHarness());
    h.scheduler.setBusyIntervals([
      event(wall(9, 10), wall(9, 10)),
      event(wall(9, 20), wall(9, 15)),
    ]);
    expect(h.timers.pending).toBe(2); // no calendar edge was armed
    advanceTo(h, wall(9, 30));
    expect(h.modes()).not.toContain('calendar');
    expect(h.startedKinds()).toEqual(['mini']);
  });

  test('precedence: disabled > dnd > calendar > away > paused', () => {
    const h = started(makeHarness());
    h.scheduler.pauseFor(3 * 60 * MINUTE);
    expect(h.lastState().mode).toBe('paused');
    h.scheduler.wentAway();
    expect(h.lastState().mode).toBe('away');
    h.scheduler.setBusyIntervals([event(wall(9), wall(11))]);
    expect(h.lastState().mode).toBe('calendar');
    h.scheduler.setDnd(true);
    expect(h.lastState().mode).toBe('dnd');
    h.scheduler.setEnabled(false);
    expect(h.lastState().mode).toBe('disabled');
    h.scheduler.setEnabled(true);
    h.scheduler.setDnd(false);
    expect(h.lastState().mode).toBe('calendar');
    h.scheduler.setBusyIntervals([]);
    expect(h.lastState().mode).toBe('away');
  });

  test('an event that ends during a pause leaves the pause in charge', () => {
    const h = started(makeHarness());
    h.scheduler.pauseFor(60 * MINUTE);
    h.scheduler.setBusyIntervals([event(wall(9, 10), wall(9, 20))]);
    advanceTo(h, wall(9, 15));
    expect(h.lastState().mode).toBe('calendar');
    advanceTo(h, wall(9, 20));
    expect(h.lastState().mode).toBe('paused');
    advanceTo(h, wall(10));
    expect(h.lastState().mode).toBe('countdown');
    expect(h.lastState().nextBreakAt).toBe(h.clock.now() + 30 * MINUTE);
  });

  test('an event that comes and goes during a short absence still ends in a fresh cycle', () => {
    const h = started(makeHarness());
    advanceTo(h, wall(9, 10));
    h.scheduler.wentAway(); // 20 minutes of countdown frozen
    h.scheduler.setBusyIntervals([event(wall(9, 11), wall(9, 12))]);
    advanceTo(h, wall(9, 13));
    h.scheduler.cameBack(3 * MINUTE);
    // Not the frozen 20 minutes: the calendar's end is a fresh cycle.
    expect(h.lastState().nextBreakAt).toBe(h.clock.now() + 30 * MINUTE);
  });

  test('an event that ends during Do Not Disturb waits for DND to go off', () => {
    const h = started(makeHarness());
    h.scheduler.setDnd(true);
    h.scheduler.setBusyIntervals([event(wall(9, 5), wall(9, 10))]);
    advanceTo(h, wall(9, 7));
    expect(h.lastState()).toMatchObject({ mode: 'dnd', busyUntilWall: wall(9, 10) });
    advanceTo(h, wall(9, 20));
    expect(h.lastState().mode).toBe('dnd');
    h.scheduler.setDnd(false);
    expect(h.lastState().mode).toBe('countdown');
    expect(h.lastState().nextBreakAt).toBe(h.clock.now() + 30 * MINUTE);
  });

  test('an owed break is dropped when the calendar gate starts: the calendar wins', () => {
    const h = started(makeHarness({ idleResetMs: 60 * MINUTE }));
    advanceTo(h, wall(9, 30, 10)); // the mini is running
    h.scheduler.wentAway({ interruptBreak: true }); // locked: the break is owed
    expect(h.endReasons()).toEqual(['interrupted']);
    h.scheduler.setBusyIntervals([event(wall(9, 35), wall(9, 45))]);
    advanceTo(h, wall(9, 50));
    // Back well inside idle-reset: without the calendar the owed mini's
    // warning would be due immediately.
    h.scheduler.cameBack(20 * MINUTE);
    h.timers.advance(0);
    expect(h.events.filter((e) => e.type === 'warn')).toHaveLength(1);
    expect(h.lastState()).toMatchObject({ mode: 'countdown', nextKind: 'mini' });
    expect(h.lastState().nextBreakAt).toBe(h.clock.now() + 30 * MINUTE);
  });

  test('an owed break cut short inside a shadow is dropped across a suspend', () => {
    const h = started(makeHarness({ idleResetMs: 60 * MINUTE }));
    advanceTo(h, wall(9, 30, 10)); // mini running until 09:31
    h.scheduler.setBusyIntervals([event(wall(9, 32), wall(9, 40))]); // shadow now
    h.scheduler.wentAway({ interruptBreak: true }); // lid closed
    // Suspended through the whole event: wall time moves, monotonic does not,
    // so no edge timer fires until the machine is back.
    h.clock.sleep(15 * MINUTE);
    h.scheduler.cameBack(15 * MINUTE);
    h.timers.advance(0);
    expect(h.events.filter((e) => e.type === 'warn')).toHaveLength(1);
    expect(h.lastState().mode).toBe('countdown');
    expect(h.lastState().nextBreakAt).toBe(h.clock.now() + 30 * MINUTE);
  });

  test('coming back inside a busy event holds straight away', () => {
    const h = started(makeHarness());
    h.scheduler.setBusyIntervals([event(wall(10), wall(11))]);
    h.scheduler.wentAway();
    h.clock.sleep(65 * MINUTE); // suspended; now 10:05
    h.scheduler.cameBack(65 * MINUTE);
    expect(h.lastState()).toMatchObject({ mode: 'calendar', busyUntilWall: wall(11) });
    expect(h.timers.pending).toBe(1);
  });

  test('longer breaks in the settings lengthen the shadow, shorter ones release it', () => {
    const h = started(makeHarness());
    h.scheduler.setBusyIntervals([event(wall(9, 20), wall(9, 25))]);
    advanceTo(h, wall(9, 15, 30)); // mini shadow starts at 09:17:50
    expect(h.lastState().mode).toBe('countdown');
    h.scheduler.updateSettings(settings({ miniDurationMs: 5 * MINUTE }));
    // 10 s + 5 min + 60 s: the shadow now starts at 09:13:50.
    expect(h.lastState()).toMatchObject({ mode: 'calendar', busyStartsWall: wall(9, 20) });
    h.scheduler.updateSettings(settings());
    expect(h.lastState().mode).toBe('countdown');
    expect(h.lastState().nextBreakAt).toBe(h.clock.now() + 30 * MINUTE);
  });

  test('the gate is re-read from wall time even when the edge timer is late', () => {
    const h = started(makeHarness());
    h.scheduler.setBusyIntervals([event(wall(10), wall(10, 30))]);
    // The wall clock jumps ahead of the monotonic one (a suspend without an
    // absence reaching the scheduler, or a corrected clock): 09:58 at mono 0.
    h.clock.sleep(58 * MINUTE);
    // The warning timer fires first, at 10:27:50 wall, inside the event.
    advanceTo(h, wall(10, 27, 50));
    expect(h.events.filter((e) => e.type === 'warn')).toEqual([]);
    expect(h.lastState()).toMatchObject({ mode: 'calendar', busyUntilWall: wall(10, 30) });
    // The edge timer was re-armed from wall time and releases on time.
    advanceTo(h, wall(10, 30));
    expect(h.lastState().mode).toBe('countdown');
    expect(h.startedKinds()).toEqual([]);
  });

  test('skipping a break that ran into a shadow arms nothing until the event is over', () => {
    const h = started(makeHarness({ minisPerLong: 0, miniIntervalMs: 54 * MINUTE }));
    h.scheduler.setBusyIntervals([event(wall(10), wall(10, 45))]);
    advanceTo(h, wall(9, 55, 40)); // the long break is running, the shadow holds
    expect(h.scheduler.skip()).toBe(true);
    expect(h.lastState()).toMatchObject({ mode: 'calendar', nextBreakAt: null });
    expect(h.timers.pending).toBe(1);
    advanceTo(h, wall(10, 45));
    expect(h.lastState().mode).toBe('countdown');
  });

  test('a postponed break is not armed inside a shadow', () => {
    const h = started(makeHarness({ minisPerLong: 0, miniIntervalMs: 55 * MINUTE }));
    advanceTo(h, wall(9, 55)); // long break running until 09:58
    h.scheduler.setBusyIntervals([event(wall(10), wall(10, 45))]); // shadow since 09:55:30
    advanceTo(h, wall(9, 55, 40));
    expect(h.scheduler.postpone()).toBe(true);
    expect(h.lastState()).toMatchObject({ mode: 'calendar', nextBreakAt: null });
    advanceTo(h, wall(10, 45));
    expect(h.startedKinds()).toEqual(['long']);
    expect(h.lastState().mode).toBe('countdown');
  });

  test('an event already running at start() holds from the outset', () => {
    const h = makeHarness();
    h.scheduler.setBusyIntervals([event(wall(8, 30), wall(9, 30))]);
    h.scheduler.start();
    expect(h.lastState()).toMatchObject({ mode: 'calendar', busyUntilWall: wall(9, 30) });
    advanceTo(h, wall(9, 30));
    expect(h.lastState().mode).toBe('countdown');
  });

  test('enabling breaks inside a busy event keeps them off until it ends', () => {
    const h = started(makeHarness());
    h.scheduler.setEnabled(false);
    h.scheduler.setBusyIntervals([event(wall(9, 5), wall(9, 50))]);
    advanceTo(h, wall(9, 10));
    h.scheduler.setEnabled(true);
    expect(h.lastState().mode).toBe('calendar');
    advanceTo(h, wall(9, 50));
    expect(h.lastState().mode).toBe('countdown');
  });

  test('stop() leaves no calendar edge timer behind', () => {
    const h = started(makeHarness());
    h.scheduler.setBusyIntervals([event(wall(12), wall(13))]);
    h.scheduler.stop();
    expect(h.timers.pending).toBe(0);
    h.scheduler.setBusyIntervals([event(wall(12), wall(13))]);
    expect(h.timers.pending).toBe(0);
    expect(h.lastState().mode).toBe('disabled');
  });
});
