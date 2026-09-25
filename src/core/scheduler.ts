/**
 * The break state machine (architecture §3).
 *
 * Deadlines are driven entirely by the monotonic clock, which stops during
 * suspend exactly like the GLib timeouts that back it, so the two never drift
 * apart. Wall time is used only for "pause until tomorrow", for the away
 * duration that the presence adapter measures, and for the calendar gate —
 * busy events are wall-clock facts, so that gate is re-read from wall time
 * whenever it is consulted rather than trusted to a monotonic countdown.
 */

import {
  calendarGateAt,
  leadShadowMs,
  nextCalendarEdge,
  normalizeBusyIntervals,
  type BusyInterval,
  type CalendarGate,
} from './calendar.js';
import type {
  BreakKind,
  Clock,
  Log,
  Mode,
  ScheduleSettings,
  SchedulerEffects,
  Snapshot,
  TimerHandle,
  Timers,
} from './types.js';

type Phase = 'countdown' | 'warning' | 'break' | 'off';

type TimerSlot = 'warning' | 'breakStart' | 'breakEnd' | 'pauseEnd' | 'calendarEdge';

const NO_CALENDAR_GATE: CalendarGate = { state: 'none' };

export class Scheduler {
  private settings: ScheduleSettings;

  private started = false;
  private enabled = true;
  private dnd = false;
  private away = false;
  private pausedUntil: number | null = null;

  /** The watched calendars' busy events, merged and sorted. */
  private busyIntervals: BusyInterval[] = [];
  /** The calendar gate as of the last {@link syncCalendar}. */
  private calendarGate: CalendarGate = NO_CALENDAR_GATE;

  private phase: Phase = 'off';
  private cycleStartedAt = 0;
  private nextBreakAt = 0;
  /** Countdown frozen while away / in DND, restored on a short return. */
  private remainingMs: number | null = null;

  private minisSinceLong = 0;
  private postponedThisBreak = false;

  private breakKind: BreakKind = 'mini';
  private breakStartedAt = 0;
  private breakDurationMs = 0;

  private readonly timerHandles = new Map<TimerSlot, TimerHandle>();

  constructor(
    settings: ScheduleSettings,
    private readonly effects: SchedulerEffects,
    private readonly clock: Clock,
    private readonly timers: Timers,
    private readonly log: Log,
  ) {
    this.settings = settings;
  }

  // -- public API ----------------------------------------------------------

  /** Extension enable: begin a fresh cycle (unless something blocks breaks). */
  start(): void {
    this.started = true;
    this.planOrIdle();
    this.emitState();
  }

  /** Extension disable: drop every timer. No effects are emitted for a break. */
  stop(): void {
    this.started = false;
    this.clearCycleTimers();
    this.clearTimer('calendarEdge');
    this.calendarGate = NO_CALENDAR_GATE;
    this.phase = 'off';
    this.remainingMs = null;
    this.emitState();
  }

  /**
   * The watched calendars' busy events changed (spec §3, calendar pause). The
   * list is merged and cleaned here; an empty list releases the gate.
   *
   * Entering the gate stops the countdown like Do Not Disturb, and a busy
   * event in progress ends a running break with `'interrupted'`, not owed.
   * Leaving it starts a fresh cycle.
   */
  setBusyIntervals(intervals: readonly BusyInterval[]): void {
    this.busyIntervals = normalizeBusyIntervals(intervals);
    this.applyCalendar();
    this.emitState();
  }

  /**
   * Overlay postpone button. Returns whether the postponement was granted;
   * refused outside a break, twice in a row, past the postpone window, or when
   * the postpone amount for this kind is zero.
   */
  postpone(): boolean {
    if (this.phase !== 'break') return false;
    if (this.postponedThisBreak) return false;
    const postponeMs = this.postponeMsFor(this.breakKind);
    if (postponeMs <= 0) return false;
    const now = this.clock.now();
    const windowEnd = this.breakStartedAt + this.breakDurationMs * this.settings.postponeWindow;
    if (now >= windowEnd) return false;

    this.clearTimer('breakEnd');
    this.effects.endBreak('postponed');
    this.postponedThisBreak = true;
    // Counters are untouched on purpose: the same kind of break comes back.
    this.cycleStartedAt = now;
    this.nextBreakAt = now + postponeMs;
    this.phase = 'countdown';
    // A break may run on into a lead shadow; the postponed one may not start
    // there, so the gate decides whether it is armed at all.
    if (this.syncCalendar()) this.planOrIdle();
    else if (this.phase === 'countdown') this.arm();
    this.emitState();
    return true;
  }

  /**
   * Overlay Skip button, or Escape — soft mode only. Returns whether the break
   * was ended; refused unless a break is actually running.
   *
   * The scheduler knows nothing about the `strict` setting: the controller
   * decides whether the overlay offers a way to call this at all, so a strict
   * break simply never does. Counters advance exactly as for a completed break
   * — a skipped break is spent, not owed, so the alternation carries on and the
   * next interval runs from the skip.
   *
   * `'skipped'` is deliberately not `'completed'`: nothing that only a finished
   * break earns (the end sound, above all) may follow from it.
   */
  skip(): boolean {
    if (this.phase !== 'break') return false;
    this.clearTimer('breakEnd');
    this.effects.endBreak('skipped');
    this.advanceAfterBreak();
    this.emitState();
    return true;
  }

  /**
   * Watchdog release, or an overlay that threw. Counters advance exactly as for
   * a completed break: by the time the watchdog fires the user has had the wall
   * in front of them for at least the full duration.
   */
  abortBreak(): void {
    if (this.phase !== 'break') return;
    this.clearTimer('breakEnd');
    try {
      this.effects.endBreak('aborted');
    } catch (err) {
      this.log('hardbreak: endBreak(aborted) threw', err);
    }
    this.advanceAfterBreak();
    this.emitState();
  }

  /**
   * Idle, locked or suspended.
   *
   * Idle leaves a running break alone — being idle is precisely what the wall
   * makes you. Lock and suspend pass `{ interruptBreak: true }`: the wall must
   * never be left standing behind the unlock dialog, and a closed lid must not
   * turn into a skipped break either, so the interrupted break is remembered as
   * owed (see {@link interruptBreak}) and {@link cameBack} decides its fate.
   */
  wentAway(options?: { interruptBreak?: boolean }): void {
    // Deliberately not conditional on the away transition: locking while the
    // idle watch has already fired must still take the wall down.
    const interrupt = options?.interruptBreak === true && this.phase === 'break';
    if (this.away && !interrupt) return;
    this.away = true;
    if (interrupt) this.interruptBreak();
    else if (this.phase === 'countdown' || this.phase === 'warning') this.freezeCountdown();
    // A break can run on into a lead shadow. Cut short there, it is not owed:
    // the calendar wins, and its end is a fresh cycle.
    if (this.calendarHeld()) this.remainingMs = null;
    this.emitState();
  }

  /**
   * Back at the machine after `awayMs` (wall time, measured by the adapter).
   * An absence at least as long as `idle-reset` counts as a break in itself; a
   * shorter one resumes the frozen countdown — which, after a break was
   * interrupted, is what brings that same break straight back.
   */
  cameBack(awayMs: number): void {
    if (!this.away) return;
    this.away = false;
    // A suspend stops the monotonic edge timer but not the calendar, so the
    // gate is re-read from wall time first. Holding drops any frozen countdown
    // or owed break, and so does a gate released while away: either way the
    // code below starts a fresh cycle (or sits idle behind the gate).
    if (this.syncCalendar()) this.remainingMs = null;
    if (awayMs >= this.settings.idleResetMs) {
      if (this.phase === 'break') {
        this.clearTimer('breakEnd');
        this.effects.endBreak('interrupted');
      }
      // A pause deliberately survives an absence, so it is not cleared here.
      this.planOrIdle();
    } else if (this.phase !== 'break') {
      this.resumeCountdown();
    }
    this.emitState();
  }

  /**
   * Do Not Disturb is a full pause (spec §3). A running break still finishes,
   * and DND going off during one changes nothing but the flag: planning a
   * fresh cycle there would set the phase to `countdown` under a wall that is
   * still up, so postpone and skip would be refused and the break's own end
   * (`advanceAfterBreak`, which plans from the flags as they are then) would
   * find a second countdown armed.
   */
  setDnd(on: boolean): void {
    if (this.dnd === on) return;
    this.dnd = on;
    if (on) {
      if (this.phase === 'countdown' || this.phase === 'warning') this.freezeCountdown();
    } else if (this.phase !== 'break') {
      this.planOrIdle();
    }
    this.emitState();
  }

  /** Panel menu "Pause 1 h" / "Pause 2 h". Ignored during a break. */
  pauseFor(ms: number): void {
    if (this.phase === 'break') return;
    this.clearCycleTimers();
    this.phase = 'off';
    this.remainingMs = null;
    this.pausedUntil = this.clock.now() + Math.max(0, ms);
    this.setTimer(
      'pauseEnd',
      Math.max(0, ms),
      this.safe('pause-end timer', () => {
        // Forget the handle first, exactly like the other three slots: GLib
        // logs a critical if a source id is removed after it has already run.
        this.timerHandles.delete('pauseEnd');
        this.pausedUntil = null;
        this.planOrIdle();
        this.emitState();
      }),
    );
    this.emitState();
  }

  /** Panel menu "Pause until tomorrow" (`morning-hour`), given as epoch ms. */
  pauseUntilWall(wallMs: number): void {
    const ms = wallMs - this.clock.wallNow();
    if (ms <= 0) {
      this.reset();
      return;
    }
    this.pauseFor(ms);
  }

  /** Panel menu "Reset": clear any pause and restart the cycle. */
  reset(): void {
    this.clearTimer('pauseEnd');
    this.pausedUntil = null;
    if (this.phase !== 'break') this.planOrIdle();
    this.emitState();
  }

  /**
   * Panel menu "Breaks" toggle. Turning breaks off ends a running break with
   * `'interrupted'` — the only user-reachable early end, and not reachable from
   * the overlay, whose input the modal owns.
   */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (on) {
      this.planOrIdle();
    } else {
      if (this.phase === 'break') {
        this.clearTimer('breakEnd');
        this.effects.endBreak('interrupted');
      }
      // The calendar edge timer keeps running: the gate stays current, and
      // turning breaks back on consults it anyway.
      this.clearCycleTimers();
      this.phase = 'off';
      this.remainingMs = null;
      this.pausedUntil = null;
    }
    this.emitState();
  }

  /**
   * Settings changed: re-plan the current wait from when it started. Warning
   * and duration make up the lead shadow, so the calendar gate is re-read too.
   */
  updateSettings(settings: ScheduleSettings): void {
    this.settings = settings;
    if (this.syncCalendar()) {
      if (this.phase !== 'break') this.planOrIdle();
    } else if (this.phase === 'countdown' || this.phase === 'warning') {
      // A shortened interval must not fire instantly under the user's hands.
      const now = this.clock.now();
      this.nextBreakAt = Math.max(now + 1000, this.cycleStartedAt + settings.miniIntervalMs);
      this.phase = 'countdown';
      this.arm();
    }
    this.emitState();
  }

  snapshot(): Snapshot {
    const scheduled = this.phase === 'countdown' || this.phase === 'warning';
    const gate = this.calendarGate;
    return {
      mode: this.mode(),
      nextKind: this.nextKind(),
      nextBreakAt: scheduled ? this.nextBreakAt : null,
      pausedUntilWall:
        this.pausedUntil === null
          ? null
          : this.clock.wallNow() + (this.pausedUntil - this.clock.now()),
      minisSinceLong: this.minisSinceLong,
      busyUntilWall: gate.state === 'busy' ? gate.busyUntilWall : null,
      busyStartsWall: gate.state === 'shadow' ? gate.busyStartWall : null,
    };
  }

  // -- planning ------------------------------------------------------------

  private blocked(): boolean {
    return (
      !this.started ||
      !this.enabled ||
      this.dnd ||
      this.calendarHeld() ||
      this.away ||
      this.pausedUntil !== null
    );
  }

  /** Start a fresh cycle, or sit idle if something blocks breaks. */
  private planOrIdle(): void {
    this.syncCalendar();
    if (this.blocked()) {
      this.clearTimer('warning');
      this.clearTimer('breakStart');
      this.phase = 'off';
      this.remainingMs = null;
      return;
    }
    this.freshCycle();
  }

  private freshCycle(): void {
    const now = this.clock.now();
    this.minisSinceLong = 0;
    this.postponedThisBreak = false;
    this.remainingMs = null;
    this.cycleStartedAt = now;
    this.nextBreakAt = now + this.settings.miniIntervalMs;
    this.phase = 'countdown';
    this.arm();
  }

  private freezeCountdown(): void {
    this.remainingMs = Math.max(0, this.nextBreakAt - this.clock.now());
    this.clearTimer('warning');
    this.clearTimer('breakStart');
    this.phase = 'off';
  }

  /**
   * Take the wall down without letting the counters move on: the same break is
   * still owed. `remainingMs` becomes that break's warning, so a short absence
   * resumes into the warning immediately and the wall follows it — an
   * interruption postpones a break by its warning, it never skips one.
   */
  private interruptBreak(): void {
    this.clearTimer('breakEnd');
    try {
      this.effects.endBreak('interrupted');
    } catch (err) {
      // Never leave the phase at `break` with no break-end timer: that would be
      // a wall with nothing left to take it down.
      this.log('hardbreak: endBreak(interrupted) threw', err);
    }
    // `minisSinceLong` and `postponedThisBreak` are untouched on purpose, so
    // `nextKind()` still names the break that was cut short.
    this.remainingMs = this.warningMsFor(this.breakKind);
    this.phase = 'off';
  }

  /** Short absence: pick the frozen countdown back up where it stopped. */
  private resumeCountdown(): void {
    if (this.blocked()) {
      this.phase = 'off';
      return;
    }
    if (this.remainingMs === null) {
      this.freshCycle();
      return;
    }
    this.nextBreakAt = this.clock.now() + this.remainingMs;
    this.remainingMs = null;
    this.phase = 'countdown';
    this.arm();
  }

  /** Arm the warning and break-start timers for the current `nextBreakAt`. */
  private arm(): void {
    this.clearTimer('warning');
    this.clearTimer('breakStart');
    const now = this.clock.now();
    const kind = this.nextKind();
    const warningMs = this.warningMsFor(kind);
    const warnAt = this.nextBreakAt - warningMs;
    // `>=`, not `>`: an interrupted break resumes with exactly its warning left,
    // and that warning has to be given rather than dropped as "already past".
    if (warningMs > 0 && warnAt >= now) {
      this.setTimer(
        'warning',
        warnAt - now,
        this.safe('warning timer', () => {
          this.timerHandles.delete('warning');
          this.onWarning();
        }),
      );
    }
    this.setTimer(
      'breakStart',
      Math.max(0, this.nextBreakAt - now),
      this.safe('break-start timer', () => {
        this.timerHandles.delete('breakStart');
        this.onBreakStart();
      }),
    );
  }

  private onWarning(): void {
    // The edge timer normally stopped the countdown already. Wall and
    // monotonic time can drift apart, though (NTP, a changed clock), so the
    // gate is asked again: no warning is ever given inside a hold.
    this.syncCalendar();
    if (this.calendarHeld()) {
      this.emitState();
      return;
    }
    // Nor for a break that would land inside one: a lead shadow beginning
    // between now and `nextBreakAt` would otherwise leave a warning with no
    // break behind it. Nothing else changes here — that hold starts at or
    // before `nextBreakAt`, so the edge timer stops the countdown first (and
    // `onBreakStart` asks the gate again if both are due at the same moment).
    if (this.breakLandsInHold()) return;
    this.phase = 'warning';
    const kind = this.nextKind();
    const secondsUntil = Math.max(0, Math.ceil((this.nextBreakAt - this.clock.now()) / 1000));
    this.effects.warn(kind, secondsUntil);
    this.emitState();
  }

  private onBreakStart(): void {
    // As in onWarning: no break ever starts inside a hold.
    this.syncCalendar();
    if (this.calendarHeld()) {
      this.emitState();
      return;
    }
    const now = this.clock.now();
    const kind = this.nextKind();
    const durationMs = this.durationMsFor(kind);
    // Set before the effect runs: if `startBreak` throws, `safe` must see a
    // break in progress and turn the failure into an abort.
    this.phase = 'break';
    this.breakKind = kind;
    this.breakStartedAt = now;
    this.breakDurationMs = durationMs;
    const postponeAllowed =
      !this.postponedThisBreak && this.postponeMsFor(kind) > 0 && this.settings.postponeWindow > 0;
    this.setTimer(
      'breakEnd',
      durationMs,
      this.safe('break-end timer', () => {
        this.timerHandles.delete('breakEnd');
        this.onBreakEnd();
      }),
    );
    this.effects.startBreak({
      kind,
      durationMs,
      postponeAllowed,
      postponeWindowMs: durationMs * this.settings.postponeWindow,
    });
    this.emitState();
  }

  private onBreakEnd(): void {
    this.effects.endBreak('completed');
    this.advanceAfterBreak();
    this.emitState();
  }

  /** Counter bookkeeping shared by completed and aborted breaks. */
  private advanceAfterBreak(): void {
    if (this.breakKind === 'long') this.minisSinceLong = 0;
    else this.minisSinceLong += 1;
    this.postponedThisBreak = false;
    this.clearTimer('breakEnd');
    // The break is over. The next kind may differ, and with it the lead
    // shadow, so the calendar gate is re-read before anything is armed.
    this.phase = 'off';
    if (this.syncCalendar()) {
      this.planOrIdle();
      return;
    }
    if (this.blocked()) {
      // DND or an absence arrived mid-break; the break finished, now sit idle.
      this.phase = 'off';
      this.remainingMs = null;
      return;
    }
    const now = this.clock.now();
    this.cycleStartedAt = now;
    this.nextBreakAt = now + this.settings.miniIntervalMs;
    this.phase = 'countdown';
    this.arm();
  }

  private nextKind(): BreakKind {
    return this.minisSinceLong >= this.settings.minisPerLong ? 'long' : 'mini';
  }

  private postponeMsFor(kind: BreakKind): number {
    return kind === 'mini' ? this.settings.miniPostponeMs : this.settings.longPostponeMs;
  }

  private warningMsFor(kind: BreakKind): number {
    return kind === 'mini' ? this.settings.miniWarningMs : this.settings.longWarningMs;
  }

  private durationMsFor(kind: BreakKind): number {
    return kind === 'mini' ? this.settings.miniDurationMs : this.settings.longDurationMs;
  }

  private mode(): Mode {
    if (!this.started || !this.enabled) return 'disabled';
    if (this.dnd) return 'dnd';
    if (this.calendarHeld()) return 'calendar';
    if (this.away) return 'away';
    if (this.pausedUntil !== null) return 'paused';
    return this.phase === 'off' ? 'disabled' : this.phase;
  }

  // -- calendar pause --------------------------------------------------------

  private calendarHeld(): boolean {
    return this.calendarGate.state !== 'none';
  }

  /**
   * Whether the gate will hold when the next break is due: `nextBreakAt`
   * mapped onto wall time, with the lead shadow of the kind that is next.
   */
  private breakLandsInHold(): boolean {
    const kind = this.nextKind();
    const shadowMs = leadShadowMs(this.warningMsFor(kind), this.durationMsFor(kind));
    const breakWall = this.clock.wallNow() + (this.nextBreakAt - this.clock.now());
    return calendarGateAt(breakWall, this.busyIntervals, shadowMs).state !== 'none';
  }

  /** Re-read the gate and act on it; a released gate is a fresh cycle. */
  private applyCalendar(): void {
    if (this.syncCalendar() && this.phase !== 'break') this.planOrIdle();
  }

  /**
   * Re-read the calendar gate from wall time, re-arm the edge timer and apply
   * a hold to the current phase. Returns `true` when the gate has just been
   * released; the caller decides how the fresh cycle that follows is started.
   *
   * The lead shadow belongs to the break that would come next, so it is
   * computed from `nextKind()` as it stands now.
   */
  private syncCalendar(): boolean {
    const wasHeld = this.calendarHeld();
    const wallNow = this.clock.wallNow();
    const kind = this.nextKind();
    const shadowMs = leadShadowMs(this.warningMsFor(kind), this.durationMsFor(kind));
    this.clearTimer('calendarEdge');
    if (!this.started) {
      this.calendarGate = NO_CALENDAR_GATE;
      return false;
    }
    this.calendarGate = calendarGateAt(wallNow, this.busyIntervals, shadowMs);
    const edge = nextCalendarEdge(wallNow, this.busyIntervals, shadowMs);
    if (edge !== null) {
      this.setTimer(
        'calendarEdge',
        edge - wallNow,
        this.safe('calendar edge timer', () => {
          this.timerHandles.delete('calendarEdge');
          // Monotonic timer, wall-time answer: whatever the gate says now.
          this.applyCalendar();
          this.emitState();
        }),
      );
    }
    if (this.calendarHeld()) this.holdForCalendar();
    return wasHeld && !this.calendarHeld();
  }

  /**
   * The gate holds. Outside a break that is exactly Do Not Disturb: the
   * countdown stops and nothing can fire. A frozen countdown or an owed break
   * is dropped as well, because leaving the gate is a fresh cycle.
   *
   * A running break is ended only by a busy event in progress (spec §3). A
   * lead shadow is a rule about *starting* breaks: a break that started before
   * its shadow runs on into it and finishes before the event by construction,
   * so it is left alone. If a late edit puts an event inside the rest of that
   * break, the edge timer brings the break down the moment the event begins.
   */
  private holdForCalendar(): void {
    switch (this.phase) {
      case 'break':
        if (this.calendarGate.state === 'busy') this.interruptForCalendar();
        return;
      case 'countdown':
      case 'warning':
        this.clearTimer('warning');
        this.clearTimer('breakStart');
        this.phase = 'off';
        this.remainingMs = null;
        return;
      case 'off':
        this.remainingMs = null;
        return;
    }
  }

  /**
   * A busy event is in progress during a break — only possible through a
   * late calendar edit. The wall comes down like it does for a lock, with the
   * same `'interrupted'` (no end sound), but the break is not owed: the
   * calendar is a deliberate bypass, and the gate's end is a fresh cycle.
   */
  private interruptForCalendar(): void {
    this.clearTimer('breakEnd');
    try {
      this.effects.endBreak('interrupted');
    } catch (err) {
      // As in interruptBreak: never leave the phase at `break` with no
      // break-end timer behind it.
      this.log('hardbreak: endBreak(interrupted) threw', err);
    }
    this.remainingMs = null;
    this.phase = 'off';
  }

  private emitState(): void {
    this.effects.stateChanged(this.snapshot());
  }

  // -- timers --------------------------------------------------------------

  private setTimer(slot: TimerSlot, ms: number, fn: () => void): void {
    this.clearTimer(slot);
    this.timerHandles.set(slot, this.timers.set(Math.max(0, ms), fn));
  }

  private clearTimer(slot: TimerSlot): void {
    const handle = this.timerHandles.get(slot);
    if (handle === undefined) return;
    this.timerHandles.delete(slot);
    try {
      this.timers.clear(handle);
    } catch (err) {
      this.log(`hardbreak: failed to clear the ${slot} timer`, err);
    }
  }

  /** Every timer except the calendar edge, which only `stop()` clears. */
  private clearCycleTimers(): void {
    // Deleting the visited key during a Map iteration is well defined.
    for (const slot of this.timerHandles.keys()) {
      if (slot !== 'calendarEdge') this.clearTimer(slot);
    }
  }

  /**
   * Timer callbacks never throw into the GLib main loop: an exception is logged
   * and, if it happened during a break, converted into an abort so the overlay
   * cannot be left on screen by a bug in the scheduler.
   */
  private safe(label: string, fn: () => void): () => void {
    return () => {
      try {
        fn();
      } catch (err) {
        this.log(`hardbreak: ${label} failed`, err);
        if (this.phase === 'break') {
          try {
            this.abortBreak();
          } catch (abortErr) {
            this.log('hardbreak: abort after a failed timer callback threw', abortErr);
          }
        }
      }
    };
  }
}
