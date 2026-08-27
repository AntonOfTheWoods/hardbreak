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
