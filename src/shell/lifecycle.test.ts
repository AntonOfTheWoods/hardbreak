import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type Shell from 'gi://Shell';

import { Scheduler } from '../core/scheduler.js';
import { createFakeTimers, FakeClock } from '../core/testing.js';
import type { BreakRequest, ScheduleSettings } from '../core/types.js';
import type { BreakContext } from './breakController.js';

// Bun types `global` as globalThis; expose the Shell members used by these
// adapters in this test-only compilation as well.
declare global {
  var backend: Shell.Global['backend'];
  var display: Shell.Global['display'];
  var stage: Shell.Global['stage'];
}

class Signals {
  private nextId = 1;
  readonly handlers = new Map<
    number,
    { signal: string; callback: (...args: unknown[]) => unknown }
  >();

  connect(signal: string, callback: (...args: unknown[]) => unknown): number {
    const id = this.nextId++;
    this.handlers.set(id, { signal, callback });
    return id;
  }

  disconnect(id: number): void {
    if (!this.handlers.delete(id)) throw new Error(`Unknown signal ${id}`);
  }

  emit(signal: string, ...args: unknown[]): void {
    for (const handler of this.handlers.values()) {
      if (handler.signal === signal) handler.callback(this, ...args);
    }
  }
}

class IdleMonitor {
  private nextId = 1;
  readonly watches = new Map<number, { active: boolean; callback: () => void }>();

  add_idle_watch(_interval: number, callback: () => void): number {
    const id = this.nextId++;
    this.watches.set(id, { active: false, callback });
    return id;
  }

  add_user_active_watch(callback: () => void): number {
    const id = this.nextId++;
    this.watches.set(id, { active: true, callback });
    return id;
  }

  remove_watch(id: number): void {
    if (!this.watches.delete(id)) throw new Error(`Unknown idle watch ${id}`);
  }

  fire(active: boolean): void {
    for (const [id, watch] of this.watches) {
      if (watch.active !== active) continue;
      if (active) this.watches.delete(id);
      watch.callback();
    }
  }
}

const shield = Object.assign(new Signals(), { locked: false });
const sessionMode = Object.assign(new Signals(), { isLocked: false });
const loginManager = new Signals();
const idleMonitor = new IdleMonitor();
const settingsInstances: Settings[] = [];
const widgets: Widget[] = [];
const notifications: Notification[] = [];
const chrome = new Set<Widget>();
const grabs = new Set<Widget>();
const sources = new Map<number, () => boolean>();
let nextSourceId = 1;
let postingFails = false;
let playbackFails = false;

class Cancellable {
  cancelCount = 0;

  cancel(): void {
    this.cancelCount++;
  }
}

const playFromFile = mock(
  (_file: { path: string }, _description: string, _cancellable: Cancellable) => {
    if (playbackFails) throw new Error('Playback failed');
  },
);

class Settings extends Signals {
  constructor() {
    super();
    settingsInstances.push(this);
  }

  get_boolean(): boolean {
    return true;
  }
}

class Widget extends Signals {
  destroyCount = 0;

  constructor() {
    super();
    widgets.push(this);
  }

  add_constraint(): void {}

  destroy_all_children(): void {}

  destroy(): void {
    this.destroyCount++;
    this.emit('destroy');
    this.handlers.clear();
  }
}

class Notification extends Signals {
  destroyCount = 0;

  constructor(readonly properties: Record<string, unknown>) {
    super();
    notifications.push(this);
  }

  destroy(): void {
    this.destroyCount++;
    this.emit('destroy');
    this.handlers.clear();
  }
}

const notificationSource = {
  addNotification: mock((_notification: Notification) => {
    if (postingFails) throw new Error('Posting failed');
  }),
  destroy: mock(() => {}),
};

const layoutManager = Object.assign(new Signals(), {
  // The real Overlay still installs its group, keyboard handlers and modal grab.
  // Monitor content is outside these lifecycle tests.
  monitors: [],
  addTopChrome: (widget: Widget) => chrome.add(widget),
  removeChrome: (widget: Widget) => {
    if (!chrome.delete(widget)) throw new Error('Unknown chrome');
  },
});

function addSource(_priority: number, _interval: number, callback: () => boolean): number {
  const id = nextSourceId++;
  sources.set(id, callback);
  return id;
}

mock.module('gi://Gio', () => ({
  default: { Settings, Cancellable, File: { new_for_path: (path: string) => ({ path }) } },
}));
mock.module('gi://GLib', () => ({
  default: {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: false,
    SOURCE_CONTINUE: true,
    timeout_add: addSource,
    timeout_add_seconds: addSource,
    Source: {
      remove: (id: number) => {
        if (!sources.delete(id)) throw new Error(`Unknown GLib source ${id}`);
      },
    },
  },
}));
mock.module('gi://Clutter', () => ({
  default: {
    BindConstraint: class {},
    BindCoordinate: { ALL: 0 },
    EVENT_STOP: true,
    KEY_Escape: 27,
  },
}));
mock.module('gi://Pango', () => ({ default: {} }));
mock.module('gi://Shell', () => ({ default: { ActionMode: { NONE: 0 } } }));
mock.module('gi://St', () => ({ default: { Widget } }));
mock.module('resource:///org/gnome/shell/misc/loginManager.js', () => ({
  getLoginManager: () => loginManager,
}));
mock.module('resource:///org/gnome/shell/ui/main.js', () => ({
  screenShield: shield,
  sessionMode,
  layoutManager,
  pushModal: (widget: Widget) => {
    grabs.add(widget);
    return widget;
  },
  popModal: (widget: Widget) => {
    if (!grabs.delete(widget)) throw new Error('Unknown modal');
  },
}));
mock.module('resource:///org/gnome/shell/ui/messageTray.js', () => ({
  Notification,
  Urgency: { CRITICAL: 3 },
  getSystemSource: () => notificationSource,
}));

const { Presence } = await import('./presence.js');
const { BreakController } = await import('./breakController.js');
const { Notifier } = await import('./notifier.js');

const originalBackend = Object.getOwnPropertyDescriptor(globalThis, 'backend');
const originalDisplay = Object.getOwnPropertyDescriptor(globalThis, 'display');
Object.defineProperty(globalThis, 'backend', {
  configurable: true,
  value: { get_core_idle_monitor: () => idleMonitor },
});
Object.defineProperty(globalThis, 'display', {
  configurable: true,
  value: { get_sound_player: () => ({ play_from_file: playFromFile }) },
});
afterAll(() => {
  if (originalBackend) Object.defineProperty(globalThis, 'backend', originalBackend);
  else Reflect.deleteProperty(globalThis, 'backend');
  if (originalDisplay) Object.defineProperty(globalThis, 'display', originalDisplay);
  else Reflect.deleteProperty(globalThis, 'display');
});

const schedule: ScheduleSettings = {
  miniIntervalMs: 30_000,
  miniDurationMs: 10_000,
  longDurationMs: 20_000,
  minisPerLong: 1,
  miniWarningMs: 2000,
  longWarningMs: 3000,
  miniPostponeMs: 5000,
  longPostponeMs: 10_000,
  postponeWindow: 0.3,
  idleResetMs: 60_000,
  morningHour: 6,
};

const cleanups: (() => void)[] = [];
const log = mock((_message: string, _error?: unknown) => {});

function mount(endSound: string | null = null) {
  const clock = new FakeClock();
  const timers = createFakeTimers(clock);
  const context: BreakContext = {
    schedule,
    overlayStyle: { rgba: 'rgba(99, 55, 56, 0.9)' },
    endSound,
    ideas: { mini: ['Rest'], long: [{ title: 'Rest', body: 'Look away' }] },
    strict: true,
  };
  const controller = new BreakController(() => context, clock, timers, log);
  const scheduler = new Scheduler(schedule, controller, clock, timers, log);
  controller.setScheduler(scheduler);
  const presence = new Presence(scheduler, schedule.idleResetMs, clock, log);
  presence.enable();
  scheduler.start();
  const destroy = () => {
    presence.disable();
    scheduler.stop();
    controller.destroy();
  };
  cleanups.push(destroy);
  return { clock, timers, controller, scheduler, context, destroy };
}

function blank(on: boolean): void {
  sessionMode.isLocked = on;
  sessionMode.emit('updated');
}

function lock(on: boolean): void {
  shield.locked = on;
  shield.emit('locked-changed');
}

function expectReleased(): void {
  expect(grabs.size).toBe(0);
  expect(chrome.size).toBe(0);
  expect(layoutManager.handlers.size).toBe(0);
  expect(sources.size).toBe(0);
  for (const widget of widgets) {
    expect(widget.destroyCount).toBe(1);
    expect(widget.handlers.size).toBe(0);
  }
}

beforeEach(() => {
  shield.locked = false;
  sessionMode.isLocked = false;
  postingFails = false;
  playbackFails = false;
  playFromFile.mockClear();
  settingsInstances.length = 0;
  widgets.length = 0;
  notifications.length = 0;
  notificationSource.addNotification.mockClear();
  notificationSource.destroy.mockClear();
  log.mockClear();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  expectReleased();
  expect(shield.handlers.size).toBe(0);
  expect(sessionMode.handlers.size).toBe(0);
  expect(loginManager.handlers.size).toBe(0);
  expect(idleMonitor.watches.size).toBe(0);
  for (const settings of settingsInstances) expect(settings.handlers.size).toBe(0);
  for (const notification of notifications) {
    expect(notification.destroyCount).toBe(1);
    expect(notification.handlers.size).toBe(0);
  }
  expect(notificationSource.destroy).not.toHaveBeenCalled();
  for (const [, , cancellable] of playFromFile.mock.calls) expect(cancellable.cancelCount).toBe(1);
});

describe('end sound ownership', () => {
  test('completed breaks play the configured sound and disable cancels it exactly once', () => {
    const { timers, destroy } = mount('/sounds/long-recording.wav');
    timers.advance(schedule.miniIntervalMs + schedule.miniDurationMs);
    expect(playFromFile).toHaveBeenCalledTimes(1);
    const [file, description, cancellable] = playFromFile.mock.calls[0]!;
    expect(file.path).toBe('/sounds/long-recording.wav');
    expect(description).toBe('Break over');
    expect(cancellable).toBeInstanceOf(Cancellable);
    expect(cancellable.cancelCount).toBe(0);
    destroy();
    destroy();
    expect(cancellable.cancelCount).toBe(1);
  });

  test('a replacement sound cancels previous playback and owns a fresh request', () => {
    const { timers, context } = mount('/sounds/first.wav');
    timers.advance(schedule.miniIntervalMs + schedule.miniDurationMs);
    const first = playFromFile.mock.calls[0]![2];
    context.endSound = '/sounds/second.wav';
    timers.advance(schedule.miniIntervalMs + schedule.longDurationMs);
    expect(playFromFile).toHaveBeenCalledTimes(2);
    const [file, , second] = playFromFile.mock.calls[1]!;
    expect(file.path).toBe('/sounds/second.wav');
    expect(first.cancelCount).toBe(1);
    expect(second).not.toBe(first);
    expect(second.cancelCount).toBe(0);
  });

  test('selecting silence releases earlier playback without starting another sound', () => {
    const { timers, context } = mount('/sounds/first.wav');
    timers.advance(schedule.miniIntervalMs + schedule.miniDurationMs);
    const first = playFromFile.mock.calls[0]![2];
    context.endSound = null;
    timers.advance(schedule.miniIntervalMs + schedule.longDurationMs);
    expect(playFromFile).toHaveBeenCalledTimes(1);
    expect(first.cancelCount).toBe(1);
  });

  test('failed playback cancels its request and leaves scheduling running', () => {
    playbackFails = true;
    const { timers, scheduler, destroy } = mount('/sounds/missing.wav');
    timers.advance(schedule.miniIntervalMs + schedule.miniDurationMs);
    expect(playFromFile).toHaveBeenCalledTimes(1);
    const cancellable = playFromFile.mock.calls[0]![2];
    expect(cancellable.cancelCount).toBe(1);
    expect(scheduler.snapshot().mode).toBe('countdown');
    expect(log).toHaveBeenCalledTimes(1);
    destroy();
    expect(cancellable.cancelCount).toBe(1);
  });

  for (const action of ['skip', 'postpone'] as const) {
    test(`${action} does not play the end sound`, () => {
      const { timers, scheduler } = mount('/sounds/end.wav');
      timers.advance(schedule.miniIntervalMs);
      expect(scheduler[action]()).toBe(true);
      expect(playFromFile).not.toHaveBeenCalled();
    });
  }
});

describe('Shell presence and overlay lifecycle', () => {
  test('mode-only blanking releases keyboard handlers and replays the owed break after a short return', () => {
    const { timers, scheduler, controller } = mount();
    timers.advance(schedule.miniIntervalMs);
    expect(controller.breakRunning).toBe(true);
    expect(widgets[0]?.handlers.size).toBe(2);
    blank(true);
    expect(shield.locked).toBe(false);
    expect(scheduler.snapshot().mode).toBe('away');
    expectReleased();
    timers.advance(1000);
    blank(false);
    timers.advance(0);
    expect(scheduler.snapshot().mode).toBe('warning');
    timers.advance(schedule.miniWarningMs);
    expect(controller.breakRunning).toBe(true);
    expect(scheduler.snapshot().nextKind).toBe('mini');
  });

  test('a long blanking absence starts a fresh cycle', () => {
    const { timers, scheduler, controller } = mount();
    timers.advance(schedule.miniIntervalMs);
    blank(true);
    timers.advance(schedule.idleResetMs);
    blank(false);
    expect(scheduler.snapshot().mode).toBe('countdown');
    expect(controller.breakRunning).toBe(false);
    timers.advance(schedule.miniIntervalMs - 1);
    expect(controller.breakRunning).toBe(false);
    timers.advance(1);
    expect(controller.breakRunning).toBe(true);
  });

  test('initial unlock-dialog state prevents scheduling while screenShield is unlocked', () => {
    sessionMode.isLocked = true;
    const { timers, scheduler, controller } = mount();
    expect(scheduler.snapshot().mode).toBe('away');
    timers.advance(schedule.miniIntervalMs * 2);
    expect(controller.breakRunning).toBe(false);
    expect(widgets).toHaveLength(0);
    blank(false);
    timers.advance(schedule.miniIntervalMs);
    expect(controller.breakRunning).toBe(true);
  });

  test('blanking interrupts even when an idle watch already marked the user away', () => {
    const { timers, scheduler, controller } = mount();
    timers.advance(schedule.miniIntervalMs);
    idleMonitor.fire(false);
    expect(controller.breakRunning).toBe(true);
    blank(true);
    expect(controller.breakRunning).toBe(false);
    expectReleased();
    blank(false);
    expect(scheduler.snapshot().mode).toBe('away');
    idleMonitor.fire(true);
    expect(scheduler.snapshot().mode).toBe('countdown');
  });

  for (const first of ['lock', 'session'] as const) {
    test(`return waits for both sources when ${first} clears first`, () => {
      const { timers, scheduler, controller } = mount();
      timers.advance(schedule.miniIntervalMs);
      blank(true);
      lock(true);
      timers.advance(1000);
      if (first === 'lock') lock(false);
      else blank(false);
      expect(scheduler.snapshot().mode).toBe('away');
      expect(controller.breakRunning).toBe(false);
      expect(timers.pending).toBe(0);
      if (first === 'lock') blank(false);
      else lock(false);
      timers.advance(0);
      expect(scheduler.snapshot().mode).toBe('warning');
      timers.advance(schedule.miniWarningMs);
      expect(controller.breakRunning).toBe(true);
    });
  }

  test('disable and enable with fresh instances leaves exactly one set of watches', () => {
    const first = mount();
    first.timers.advance(schedule.miniIntervalMs);
    first.destroy();
    expectReleased();
    expect(first.timers.pending).toBe(0);
    expect(shield.handlers.size).toBe(0);
    expect(sessionMode.handlers.size).toBe(0);
    expect(idleMonitor.watches.size).toBe(0);
    const second = mount();
    expect(shield.handlers.size).toBe(1);
    expect(sessionMode.handlers.size).toBe(1);
    expect(loginManager.handlers.size).toBe(1);
    expect(idleMonitor.watches.size).toBe(1);
    second.timers.advance(schedule.miniIntervalMs);
    expect(second.controller.breakRunning).toBe(true);
    blank(true);
    expectReleased();
    expect(first.timers.pending).toBe(0);
    expect(second.timers.pending).toBe(0);
  });

  test('controller independently refuses a break in unlock-dialog and disarms its watchdog', () => {
    const { controller, timers } = mount();
    blank(true);
    const abortBreak = mock(() => {});
    controller.setScheduler({ abortBreak, postpone: () => false, skip: () => false });
    const request: BreakRequest = {
      kind: 'mini',
      durationMs: schedule.miniDurationMs,
      postponeAllowed: true,
      postponeWindowMs: 3000,
    };
    controller.startBreak(request);
    expect(abortBreak).toHaveBeenCalledTimes(1);
    expect(controller.breakRunning).toBe(false);
    expect(widgets).toHaveLength(0);
    expect(timers.pending).toBe(0);
    expectReleased();
  });
});

describe('notification ownership', () => {
  function notifier() {
    const instance = new Notifier(log);
    cleanups.push(() => instance.destroy());
    return instance;
  }

  test('destroy removes the persistent notice and warning exactly once', () => {
    const instance = notifier();
    expect(instance.postNotice('Welcome', 'Recovery instructions')).toBe(true);
    expect(notifications[0]?.properties['isTransient']).toBe(false);
    instance.warn('mini', 10, 60_000);
    instance.destroy();
    instance.destroy();
    expect(notifications.map((notice) => notice.destroyCount)).toEqual([1, 1]);
  });

  test('a tray-dismissed notice is not destroyed again, and its replacement is owned', () => {
    const instance = notifier();
    instance.postNotice('First', 'Notice');
    notifications[0]?.destroy();
    instance.postNotice('Second', 'Notice');
    instance.destroy();
    expect(notifications.map((notice) => notice.destroyCount)).toEqual([1, 1]);
  });

  test('independent warning dismissal does not destroy the first-run notice', () => {
    const instance = notifier();
    instance.postNotice('Welcome', 'Recovery instructions');
    instance.warn('mini', 10, 60_000);
    notifications[1]?.destroy();
    instance.dismiss();
    expect(notifications[0]?.destroyCount).toBe(0);
    expect(notifications[1]?.destroyCount).toBe(1);
  });

  test('failed notice and warning posts release objects and report failure', () => {
    postingFails = true;
    const instance = notifier();
    expect(instance.postNotice('Welcome', 'Recovery instructions')).toBe(false);
    instance.warn('mini', 10, 60_000);
    expect(notifications.map((notice) => notice.destroyCount)).toEqual([1, 1]);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
