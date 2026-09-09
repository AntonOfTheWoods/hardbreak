/**
 * "Is the user at the machine, and are breaks wanted right now?" (architecture §5).
 *
 * Idle, the lock screen, screen blanking and suspend count as being away and overlap
 * constantly (locking makes you idle; suspending happens while locked), so they
 * are kept in a set and only the ∅ ↔ non-empty transitions reach the scheduler.
 * The one exception is a running break: lock and suspend must take the wall down
 * whenever they happen, transition or not, because the idle watch has usually
 * fired first (the wall is what makes you idle) and the wall must never end up
 * behind the unlock dialog. Do Not Disturb is separate: it is a full pause, not
 * an absence (spec §3).
 */

import Gio from 'gi://Gio';
import type Meta from 'gi://Meta';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type { Clock, Log } from '../core/types.js';

/** The part of the scheduler this adapter drives. */
export interface PresenceTarget {
  wentAway(options?: { interruptBreak?: boolean }): void;
  cameBack(awayMs: number): void;
  setDnd(on: boolean): void;
}

type AwayReason = 'idle' | 'lock' | 'session' | 'sleep';

/** `Main.screenShield` is `any` in @girs; this is all that is used of it. */
interface ScreenShieldLike {
  readonly locked: boolean;
  connect(signal: 'locked-changed', callback: () => void): number;
  disconnect(id: number): void;
}

interface SessionModeLike {
  readonly isLocked: boolean;
  connect(signal: 'updated', callback: () => void): number;
  disconnect(id: number): void;
}

/** Only the `prepare-for-sleep` signal is used of the login manager. */
interface SleepEmitter {
  connect(
    signal: 'prepare-for-sleep',
    callback: (manager: unknown, aboutToSuspend: boolean) => void,
  ): number;
  disconnect(id: number): void;
}

const DND_SCHEMA = 'org.gnome.desktop.notifications';
const DND_KEY = 'show-banners';

export class Presence {
  private readonly awayReasons = new Set<AwayReason>();
  /** Epoch ms the current absence began; only meaningful while away. */
  private awaySinceWall = 0;

  private idleMonitor: Meta.IdleMonitor | null = null;
  private idleWatchId = 0;
  private activeWatchId = 0;

  private shield: ScreenShieldLike | null = null;
  private shieldId = 0;

  private sessionMode: SessionModeLike | null = null;
  private sessionModeId = 0;

  private loginManager: SleepEmitter | null = null;
  private sleepId = 0;

  private dndSettings: Gio.Settings | null = null;
  private dndChangedId = 0;

  constructor(
    private readonly scheduler: PresenceTarget,
    private idleResetMs: number,
    private readonly clock: Clock,
    private readonly log: Log,
  ) {}

  /**
   * Install every watch and seed the scheduler with the state the session is
   * already in (locked at login, DND left on from yesterday).
   */
  enable(): void {
    this.installIdleWatch();

    // Shell omits screenShield when its login manager cannot lock the session.
    const shield = Main.screenShield as ScreenShieldLike | null;
    if (shield) {
      this.shield = shield;
      this.shieldId = shield.connect('locked-changed', () => {
        this.safely('locked-changed', () => this.setReason('lock', shield.locked));
      });
      if (shield.locked) this.awayReasons.add('lock');
    }

    // Screen blanking can enter unlock-dialog before screenShield.locked becomes
    // true. Keep both sources until each has cleared, regardless of signal order.
    const sessionMode = Main.sessionMode as SessionModeLike;
    this.sessionMode = sessionMode;
    this.sessionModeId = sessionMode.connect('updated', () => {
      this.safely('session-mode updated', () => {
        this.setReason('session', sessionMode.isLocked);
      });
    });
    if (sessionMode.isLocked) this.awayReasons.add('session');

    try {
      const manager = LoginManager.getLoginManager() as unknown as SleepEmitter;
      this.loginManager = manager;
      this.sleepId = manager.connect('prepare-for-sleep', (_manager, aboutToSuspend) => {
        this.safely('prepare-for-sleep', () => this.setReason('sleep', aboutToSuspend === true));
      });
    } catch (err) {
      this.log('hardbreak: could not watch prepare-for-sleep', err);
    }

    if (this.awayReasons.size > 0) {
      this.awaySinceWall = this.clock.wallNow();
      this.scheduler.wentAway({
        interruptBreak: this.awayReasons.has('lock') || this.awayReasons.has('session'),
      });
    }

    try {
      const dnd = new Gio.Settings({ schema_id: DND_SCHEMA });
      this.dndSettings = dnd;
      this.dndChangedId = dnd.connect(`changed::${DND_KEY}`, () => {
        this.safely('show-banners changed', () => {
          this.scheduler.setDnd(!dnd.get_boolean(DND_KEY));
        });
      });
      this.scheduler.setDnd(!dnd.get_boolean(DND_KEY));
    } catch (err) {
      this.log(`hardbreak: could not watch ${DND_SCHEMA} ${DND_KEY}`, err);
    }
  }

  disable(): void {
    this.removeIdleWatch();
    this.removeActiveWatch();

    const shield = this.shield;
    this.shield = null;
    if (shield && this.shieldId !== 0) {
      shield.disconnect(this.shieldId);
    }
    this.shieldId = 0;

    const sessionMode = this.sessionMode;
    this.sessionMode = null;
    if (sessionMode && this.sessionModeId !== 0) {
      sessionMode.disconnect(this.sessionModeId);
    }
    this.sessionModeId = 0;

    const manager = this.loginManager;
    this.loginManager = null;
    if (manager && this.sleepId !== 0) {
      manager.disconnect(this.sleepId);
    }
    this.sleepId = 0;

    const dnd = this.dndSettings;
    this.dndSettings = null;
    if (dnd && this.dndChangedId !== 0) {
      dnd.disconnect(this.dndChangedId);
    }
    this.dndChangedId = 0;

    this.idleMonitor = null;
    this.awayReasons.clear();
  }

  /** `idle-reset` changed: the idle watch fires at that interval, so re-install it. */
  setIdleResetMs(ms: number): void {
    if (ms === this.idleResetMs) return;
    this.idleResetMs = ms;
    this.installIdleWatch();
  }

  // -- idle ------------------------------------------------------------------

  /**
   * Only the idle watch is replaced here. The user-active watch is the one
   * thing that can clear `'idle'` again, and the idle watch only ever fires on
   * the way *in*, so tearing the active watch down while the user is idle would
   * strand the absence for good.
   */
  private installIdleWatch(): void {
    this.removeIdleWatch();
    try {
      const monitor = global.backend.get_core_idle_monitor();
      this.idleMonitor = monitor;
      this.idleWatchId = monitor.add_idle_watch(
        Math.max(1000, Math.round(this.idleResetMs)),
        () => {
          this.safely('idle watch', () => this.onIdle());
        },
      );
      // A re-install on a fresh monitor (or after a failed one) can arrive with
      // `'idle'` already set and nothing watching for the return.
      if (this.awayReasons.has('idle')) this.installActiveWatch();
    } catch (err) {
      this.log('hardbreak: could not install the idle watch', err);
    }
  }

  /** One-shot: the next moment of activity clears `'idle'` and the watch. */
  private installActiveWatch(): void {
    const monitor = this.idleMonitor;
    if (!monitor || this.activeWatchId !== 0) return;
    this.activeWatchId = monitor.add_user_active_watch(() => {
      // The active watch is one-shot: it is gone by the time this runs.
      this.activeWatchId = 0;
      this.safely('user-active watch', () => this.setReason('idle', false));
    });
  }

  private removeIdleWatch(): void {
    const id = this.idleWatchId;
    this.idleWatchId = 0;
    this.removeWatch(id);
  }

  private removeActiveWatch(): void {
    const id = this.activeWatchId;
    this.activeWatchId = 0;
    this.removeWatch(id);
  }

  private removeWatch(id: number): void {
    const monitor = this.idleMonitor;
    if (!monitor || id === 0) return;
    monitor.remove_watch(id);
  }

  private onIdle(): void {
    this.installActiveWatch();
    // The watch only fires once the interval has already elapsed, so the
    // absence started `idleResetMs` ago, not now.
    this.setReason('idle', true, this.clock.wallNow() - this.idleResetMs);
  }

  // -- away bookkeeping ------------------------------------------------------

  private setReason(reason: AwayReason, on: boolean, sinceWall?: number): void {
    const wasAway = this.awayReasons.size > 0;
    if (on) this.awayReasons.add(reason);
    else this.awayReasons.delete(reason);
    const isAway = this.awayReasons.size > 0;
    // Locking, blanking or suspending interrupts a running break; going idle does not.
    // This is not conditional on the ∅ → non-empty transition, because by the
    // time the screen locks the idle watch has usually already fired.
    const interrupts = on && reason !== 'idle';

    if (isAway) {
      if (!wasAway) this.awaySinceWall = sinceWall ?? this.clock.wallNow();
      if (interrupts) this.scheduler.wentAway({ interruptBreak: true });
      else if (!wasAway) this.scheduler.wentAway();
    } else if (wasAway) {
      // Wall time, not monotonic: an absence spent suspended still counts.
      this.scheduler.cameBack(Math.max(0, this.clock.wallNow() - this.awaySinceWall));
    }
  }

  /** Nothing thrown by a GLib/D-Bus callback may escape into the main loop. */
  private safely(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`hardbreak: ${label} failed`, err);
    }
  }
}
