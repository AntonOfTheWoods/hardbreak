/**
 * `SchedulerEffects` for the Shell (architecture §4 and §5).
 *
 * This is where the watchdog contract lives. The order in {@link
 * BreakController.startBreak} is not negotiable: the hard deadline is armed
 * *before* the first call that touches the Shell, so even a failure inside
 * `pushModal` is already covered. Teardown is idempotent because it is reached
 * from three directions — the normal end, the watchdog, and the abort that the
 * watchdog itself triggers through the scheduler.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { pickIdea } from '../core/ideas.js';
import type {
  BreakEndReason,
  BreakKind,
  BreakRequest,
  Clock,
  IdeaBook,
  Log,
  ScheduleSettings,
  SchedulerEffects,
  Snapshot,
  Timers,
} from '../core/types.js';
import { WATCHDOG_MARGIN_MS, Watchdog } from '../core/watchdog.js';
import { Notifier } from './notifier.js';
import { Overlay } from './overlay.js';
import type { OverlayStyle } from './settings.js';

/** `Main.screenShield` is `any` in @girs; only `locked` is needed here. */
interface ScreenShieldLike {
  readonly locked: boolean;
}

interface SessionModeLike {
  readonly isLocked: boolean;
}

/** Everything read fresh from `Gio.Settings` (and the idea file) at break time. */
export interface BreakContext {
  schedule: ScheduleSettings;
  overlayStyle: OverlayStyle;
  /** Absolute path of the end sound, or `null` for silence. */
  endSound: string | null;
  ideas: IdeaBook;
  /** `strict`: no Skip button and no Escape on this break's overlay. */
  strict: boolean;
}

/** The part of the scheduler the controller drives back. */
export interface BreakSchedulerTarget {
  postpone(): boolean;
  skip(): boolean;
  abortBreak(): void;
}

export class BreakController implements SchedulerEffects {
  private readonly overlay: Overlay;
  private readonly notifier: Notifier;
  private readonly watchdog: Watchdog;

  private scheduler: BreakSchedulerTarget | null = null;
  private stateListener: ((snapshot: Snapshot) => void) | null = null;
  private soundCancellable: Gio.Cancellable | null = null;

  private tickId = 0;
  private postponeHideId = 0;
  private breakStartedAt = 0;
  private breakDurationMs = 0;

  constructor(
    private readonly readContext: () => BreakContext,
    private readonly clock: Clock,
    /** Prioritizes release among ready sources; cannot preempt a blocked main loop. */
    watchdogTimers: Timers,
    private readonly log: Log,
  ) {
    this.overlay = new Overlay(log, (label, err) => this.onOverlayError(label, err));
    this.notifier = new Notifier(log);
    this.watchdog = new Watchdog(watchdogTimers, (reason) => this.forceRelease(reason), log);
  }

  /** Injected after construction: the scheduler needs the effects first. */
  setScheduler(scheduler: BreakSchedulerTarget | null): void {
    this.scheduler = scheduler;
  }

  /** The indicator registers here; `null` unregisters (used by `disable()`). */
  onState(listener: ((snapshot: Snapshot) => void) | null): void {
    this.stateListener = listener;
  }

  /** Whether the wall is up, i.e. whether input is currently grabbed. */
  get breakRunning(): boolean {
    return this.overlay.visible;
  }

  // -- SchedulerEffects ------------------------------------------------------

  warn(kind: BreakKind, secondsUntil: number): void {
    try {
      const { schedule } = this.readContext();
      const durationMs = kind === 'mini' ? schedule.miniDurationMs : schedule.longDurationMs;
      this.notifier.warn(kind, secondsUntil, durationMs);
    } catch (err) {
      this.log('hardbreak: could not warn about the coming break', err);
    }
  }

  startBreak(request: BreakRequest): void {
    // 1. Arm first. Everything after this line is covered by the deadline.
    this.watchdog.arm(request.durationMs + WATCHDOG_MARGIN_MS);
    this.breakStartedAt = this.clock.now();
    this.breakDurationMs = request.durationMs;

    // 2. Every Shell-touching step is guarded: a throw releases the modal.
    this.watchdog.guard('break start', () => {
      // The wall is top chrome, so it would paint over the unlock dialog and
      // grab the keyboard the user needs for their password. Throwing here is
      // the wanted exit: the guard releases and the scheduler aborts the break.
      const shield = Main.screenShield as ScreenShieldLike | null;
      const sessionMode = Main.sessionMode as SessionModeLike;
      // Blanking can enter unlock-dialog without requiring a password.
      if (shield?.locked || sessionMode.isLocked) throw new Error('screen is locked or blanked');

      this.notifier.dismiss();
      const context = this.readContext();
      const idea = pickIdea(context.ideas, request.kind);
      const postponeMs =
        request.kind === 'mini' ? context.schedule.miniPostponeMs : context.schedule.longPostponeMs;
      // The mode is decided here, once, from the settings as they are at the
      // start of *this* break: the scheduler knows nothing about `strict`, and
      // a strict overlay is simply one that was never given a way to skip.
      this.overlay.show(
        request,
        idea,
        context.overlayStyle,
        postponeMs,
        () => this.onPostpone(),
        context.strict ? null : () => this.onSkip(),
      );
      this.startTick();
      this.schedulePostponeHide(request);
    });
  }

  endBreak(reason: BreakEndReason): void {
    // Teardown first, disarm second: if teardown throws in some way its own
    // per-step guards did not catch, the deadline is still standing and the
    // watchdog will do the release instead.
    this.teardown();
    this.watchdog.disarm();
    // `'completed'` only: a skipped, postponed, interrupted or aborted break
    // has not earned the chime that says the break is over.
    if (reason === 'completed') this.playEndSound();
  }

  stateChanged(snapshot: Snapshot): void {
    try {
      this.stateListener?.(snapshot);
    } catch (err) {
      this.log('hardbreak: a state listener threw', err);
    }
  }

  // -- release ---------------------------------------------------------------

  /**
   * The watchdog can also fire after the overlay has gone, for example when
   * a postpone callback fails. Teardown therefore tolerates absent resources.
   */
  forceRelease(reason: string): void {
    this.log(`hardbreak: force release (${reason})`);
    this.teardown();
    this.watchdog.disarm();
    const scheduler = this.scheduler;
    if (!scheduler) return;
    try {
      // Re-enters `endBreak('aborted')`, hence the idempotent teardown.
      scheduler.abortBreak();
    } catch (err) {
      this.log('hardbreak: aborting the break after a force release threw', err);
    }
  }

  /** Extension disable. Leaves nothing armed and no GLib source behind. */
  destroy(): void {
    this.setScheduler(null);
    this.onState(null);
    this.watchdog.disarm();
    this.teardown();
    this.notifier.destroy();
    this.stopEndSound();
  }

  // -- internals -------------------------------------------------------------

  /**
   * Do not call Watchdog.guard here: firing it during endBreak would re-enter
   * the scheduler mid-transition. Overlay.hide handles modal recovery itself.
   */
  private teardown(): void {
    this.stopTick();
    this.stopPostponeHide();
    this.overlay.hide();
    this.notifier.dismiss();
  }

  /**
   * A failure the overlay caught but cannot handle. `Watchdog.fire` is private
   * — re-throwing inside `guard` is the way in, and gives exactly the log and
   * release path any other break-path exception would have taken.
   */
  private onOverlayError(label: string, err: unknown): void {
    this.watchdog.guard(label, () => {
      throw err;
    });
  }

  private onPostpone(): boolean {
    const scheduler = this.scheduler;
    if (!scheduler) return false;
    return this.watchdog.guard('postpone', () => scheduler.postpone()) === true;
  }

  /** Soft mode's Skip button and Escape key; never reached in strict mode. */
  private onSkip(): boolean {
    const scheduler = this.scheduler;
    if (!scheduler) return false;
    return this.watchdog.guard('skip', () => scheduler.skip()) === true;
  }

  /** One repaint a second, computed from the clock so drift cannot accumulate. */
  private startTick(): void {
    this.stopTick();
    this.tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
      if (this.tickId === 0 || !this.overlay.visible) {
        this.tickId = 0;
        return GLib.SOURCE_REMOVE;
      }
      this.watchdog.guard('countdown tick', () => {
        this.overlay.tick(this.breakDurationMs - (this.clock.now() - this.breakStartedAt));
      });
      return this.tickId === 0 ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
    });
  }

  private stopTick(): void {
    const id = this.tickId;
    this.tickId = 0;
    if (id === 0) return;
    GLib.Source.remove(id);
  }

  /** The postpone button only exists for the first `postponeWindowMs`. */
  private schedulePostponeHide(request: BreakRequest): void {
    this.stopPostponeHide();
    if (!request.postponeAllowed) return;
    const windowMs = Math.max(0, Math.round(request.postponeWindowMs));
    if (windowMs <= 0 || windowMs >= request.durationMs) return;
    this.postponeHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, windowMs, () => {
      this.postponeHideId = 0;
      this.watchdog.guard('postpone window', () => this.overlay.hidePostpone());
      return GLib.SOURCE_REMOVE;
    });
  }

  private stopPostponeHide(): void {
    const id = this.postponeHideId;
    this.postponeHideId = 0;
    if (id === 0) return;
    GLib.Source.remove(id);
  }

  /** Never throws out: a missing sound file must not abort anything. */
  private playEndSound(): void {
    this.stopEndSound();
    try {
      const { endSound } = this.readContext();
      if (endSound === null) return;
      this.soundCancellable = new Gio.Cancellable();
      global.display
        .get_sound_player()
        .play_from_file(Gio.File.new_for_path(endSound), 'Break over', this.soundCancellable);
    } catch (err) {
      this.stopEndSound();
      this.log('hardbreak: could not play the end-of-break sound', err);
    }
  }

  private stopEndSound(): void {
    this.soundCancellable?.cancel();
    this.soundCancellable = null;
  }
}
