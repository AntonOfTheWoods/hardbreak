/**
 * The panel indicator (spec §6, architecture §5).
 *
 * Icon only — no countdown label, because a per-second panel repaint is both a
 * nag and a needless wake-up. The status line is computed when the menu opens,
 * from the last snapshot the scheduler emitted.
 *
 * The extension declares the `unlock-dialog` session mode (`metadata.json`), so
 * unlike most extensions it keeps running while the screen is locked — which
 * means hiding the panel button on the lock screen is our job, not the panel's.
 */

import type Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { nextMorningWall } from '../core/morning.js';
import type { Clock, Log, Snapshot } from '../core/types.js';

const HOUR_MS = 3_600_000;
const DIM_CLASS = 'hardbreak-paused';

/** `Main.sessionMode` is `any` in @girs; this is all that is used of it. */
interface SessionModeLike {
  readonly isLocked: boolean;
  connect(signal: 'updated', callback: () => void): number;
  disconnect(id: number): void;
}

/** The part of the scheduler the menu drives. */
export interface IndicatorTarget {
  pauseFor(ms: number): void;
  pauseUntilWall(wallMs: number): void;
  reset(): void;
}

export class Indicator {
  private button: PanelMenu.Button | null = null;
  private icon: St.Icon | null = null;
  private statusItem: PopupMenu.PopupMenuItem | null = null;
  private switchItem: PopupMenu.PopupSwitchMenuItem | null = null;

  private sessionMode: SessionModeLike | null = null;
  private sessionModeId = 0;

  private openStateId = 0;
  private toggledId = 0;
  private settingsChangedId = 0;
  /** Guards the settings ↔ switch loop: neither may re-trigger the other. */
  private syncing = false;

  private snapshot: Snapshot | null = null;

  constructor(
    private readonly scheduler: IndicatorTarget,
    private readonly settings: Gio.Settings,
    private readonly clock: Clock,
    private readonly log: Log,
  ) {}

  /** Build the button and add it to the panel. */
  enable(): void {
    if (this.button) return;

    const button = new PanelMenu.Button(0.0, 'hardbreak', false);
    this.button = button;

    const icon = new St.Icon({ icon_name: 'alarm-symbolic', style_class: 'system-status-icon' });
    this.icon = icon;
    button.add_child(icon);

    // `dontCreateMenu` was false above, so this is a real PopupMenu.
    const menu = button.menu as PopupMenu.PopupMenu;

    const statusItem = new PopupMenu.PopupMenuItem('', { reactive: false, can_focus: false });
    this.statusItem = statusItem;
    menu.addMenuItem(statusItem);
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this.addAction(menu, 'Pause 1 hour', () => this.scheduler.pauseFor(HOUR_MS));
    this.addAction(menu, 'Pause 2 hours', () => this.scheduler.pauseFor(2 * HOUR_MS));
    this.addAction(menu, 'Pause until tomorrow', () => {
      const morningHour = this.settings.get_int('morning-hour');
      this.scheduler.pauseUntilWall(nextMorningWall(this.clock.wallNow(), morningHour));
    });
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    this.addAction(menu, 'Reset', () => this.scheduler.reset());

    const switchItem = new PopupMenu.PopupSwitchMenuItem(
      'Breaks',
      this.settings.get_boolean('breaks-enabled'),
    );
    this.switchItem = switchItem;
    // The switch writes the setting; the extension reacts to the setting. That
    // way a dconf edit and the menu take exactly the same path.
    this.toggledId = switchItem.connect('toggled', (_item, state) => {
      if (this.syncing) return;
      try {
        this.settings.set_boolean('breaks-enabled', state);
      } catch (err) {
        this.log('hardbreak: could not write breaks-enabled', err);
      }
    });
    menu.addMenuItem(switchItem);

    this.settingsChangedId = this.settings.connect('changed::breaks-enabled', () => {
      this.syncSwitch();
    });

    this.openStateId = menu.connect('open-state-changed', (_menu, open) => {
      if (open) this.refreshStatus();
    });

    Main.panel.addToStatusArea('hardbreak', button);

    const sessionMode = Main.sessionMode as SessionModeLike;
    this.sessionMode = sessionMode;
    this.sessionModeId = sessionMode.connect('updated', () => this.syncVisibility());
    // `addToStatusArea` shows the container, so this has to come after it.
    this.syncVisibility();

    this.refreshStatus();
  }

  /** Latest scheduler state. Cheap: it caches and only restyles the icon. */
  update(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    const icon = this.icon;
    if (!icon) return;
    const counting = snapshot.mode === 'countdown' || snapshot.mode === 'warning';
    if (counting) icon.remove_style_class_name(DIM_CLASS);
    else icon.add_style_class_name(DIM_CLASS);
  }

  destroy(): void {
    const button = this.button;
    this.button = null;

    const sessionMode = this.sessionMode;
    this.sessionMode = null;
    if (sessionMode && this.sessionModeId !== 0) {
      sessionMode.disconnect(this.sessionModeId);
    }
    this.sessionModeId = 0;

    if (this.settingsChangedId !== 0) {
      this.settings.disconnect(this.settingsChangedId);
      this.settingsChangedId = 0;
    }

    const switchItem = this.switchItem;
    if (switchItem && this.toggledId !== 0) {
      switchItem.disconnect(this.toggledId);
    }
    this.toggledId = 0;

    if (button && this.openStateId !== 0) {
      (button.menu as PopupMenu.PopupMenu).disconnect(this.openStateId);
    }
    this.openStateId = 0;

    this.statusItem = null;
    this.switchItem = null;
    this.icon = null;
    this.snapshot = null;

    button?.destroy();
  }

  // -- internals -------------------------------------------------------------

  /**
   * `Panel._hideIndicators` only touches the Shell's own roles, so an extension
   * that survives the lock screen has to hide itself. It is the `container`
   * (an `St.Bin`) that the panel actually packs into a box — hiding the button
   * inside it would leave the panel spacing behind.
   */
  private syncVisibility(): void {
    const button = this.button;
    if (!button) return;
    button.container.visible = this.sessionMode?.isLocked !== true;
  }

  private addAction(menu: PopupMenu.PopupMenu, label: string, action: () => void): void {
    const item = new PopupMenu.PopupMenuItem(label);
    item.connect('activate', () => {
      try {
        action();
      } catch (err) {
        this.log(`hardbreak: the "${label}" menu item failed`, err);
      }
    });
    menu.addMenuItem(item);
  }

  private syncSwitch(): void {
    const item = this.switchItem;
    if (!item) return;
    this.syncing = true;
    try {
      item.setToggleState(this.settings.get_boolean('breaks-enabled'));
    } finally {
      this.syncing = false;
    }
  }

  private refreshStatus(): void {
    const item = this.statusItem;
    if (!item) return;
    item.label.text = this.statusText();
  }

  private statusText(): string {
    const snapshot = this.snapshot;
    if (!snapshot) return 'Breaks disabled';
    switch (snapshot.mode) {
      case 'break':
        return 'Break in progress';
      case 'disabled':
        return 'Breaks disabled';
      case 'dnd':
        return 'Do Not Disturb';
      case 'away':
        return 'Away';
      case 'paused':
        return snapshot.pausedUntilWall === null
          ? 'Paused'
          : `Paused until ${formatWallTime(snapshot.pausedUntilWall)}`;
      case 'countdown':
      case 'warning': {
        if (snapshot.nextBreakAt === null) return 'Breaks disabled';
        const delay = formatDelay(snapshot.nextBreakAt - this.clock.now());
        return `Next: ${snapshot.nextKind} break in ${delay}`;
      }
    }
  }
}

/** Local 24-hour `HH:MM`, which is what "Paused until 06:00" wants. */
function formatWallTime(wallMs: number): string {
  const date = new Date(wallMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Coarse on purpose: the menu is not a countdown. */
function formatDelay(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.ceil(seconds / 60)} min`;
}
