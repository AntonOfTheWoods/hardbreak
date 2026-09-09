/**
 * Wiring (architecture §5). Everything created in `enable()` is destroyed in
 * `disable()` — GNOME's review rules, but also the only way an extension that
 * can grab the whole session is safe to reload.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { parseIdeaBook } from './core/ideas.js';
import { Scheduler } from './core/scheduler.js';
import type { IdeaBook, Log } from './core/types.js';
import { BreakController, type BreakContext } from './shell/breakController.js';
import { createClock, createLog, createTimers } from './shell/gjsPorts.js';
import { Indicator } from './shell/indicator.js';
import { Notifier } from './shell/notifier.js';
import { Presence } from './shell/presence.js';
import {
  readOverlayStyle,
  readScheduleSettings,
  readStrict,
  resolveEndSound,
  SCHEDULE_KEYS,
} from './shell/settings.js';

export default class HardbreakExtension extends Extension {
  private log: Log = () => {};
  private settings: Gio.Settings | null = null;
  private settingsChangedId = 0;
  private scheduler: Scheduler | null = null;
  private controller: BreakController | null = null;
  private presence: Presence | null = null;
  private indicator: Indicator | null = null;
  private firstRunNotifier: Notifier | null = null;
  private ideas: IdeaBook = emptyIdeas();
  private ideasCancellable: Gio.Cancellable | null = null;

  override enable(): void {
    this.log = createLog();
    try {
      this.build();
    } catch (err) {
      // Half-built is the worst state for something that grabs the session.
      this.log('hardbreak: enable failed, tearing down what was built', err);
      this.disable();
      throw err;
    }
  }

  override disable(): void {
    // Session modes: metadata.json declares `unlock-dialog` so this extension is
    // NOT disabled when the screen locks. Reason: the schedule must observe
    // lock/unlock (a short lock resumes the countdown, a long one restarts the
    // cycle, a lock during a break interrupts it), which is impossible if GNOME
    // calls disable() on every lock. On the lock screen the panel indicator hides
    // itself and no break can start (presence marks the session away; the
    // controller also refuses overlays in the `unlock-dialog` session mode).
    // disable() below still tears down everything unconditionally.
    // First and foremost: if the wall is up, take it down. This has to happen
    // before `scheduler.stop()`, because the abort it triggers re-arms the
    // countdown — and `stop()` is what clears those sources again.
    const controller = this.controller;
    if (controller?.breakRunning) {
      controller.forceRelease('disable');
    }

    const presence = this.presence;
    this.presence = null;
    presence?.disable();

    const scheduler = this.scheduler;
    this.scheduler = null;
    scheduler?.stop();

    const indicator = this.indicator;
    this.indicator = null;
    indicator?.destroy();

    this.controller = null;
    controller?.destroy();

    this.firstRunNotifier?.destroy();
    this.firstRunNotifier = null;

    const settings = this.settings;
    const settingsChangedId = this.settingsChangedId;
    this.settings = null;
    this.settingsChangedId = 0;
    if (settings && settingsChangedId !== 0) {
      settings.disconnect(settingsChangedId);
    }

    // An idea-book read may still be in flight; its callback checks the token.
    const ideasCancellable = this.ideasCancellable;
    this.ideasCancellable = null;
    ideasCancellable?.cancel();

    this.ideas = emptyIdeas();
    this.log = () => {};
  }

  // -- internals -------------------------------------------------------------

  private build(): void {
    const log = this.log;
    const clock = createClock();
    const settings = this.getSettings();
    this.settings = settings;
    // Filled in by the asynchronous read below; empty until it lands.
    this.ideas = emptyIdeas();
    this.loadIdeas(log);

    // Read fresh at break time, so a settings change lands on the next break
    // without any invalidation bookkeeping.
    const readContext = (): BreakContext => ({
      schedule: readScheduleSettings(settings),
      overlayStyle: readOverlayStyle(settings),
      endSound: resolveEndSound(settings, this.path),
      ideas: this.ideas,
      strict: readStrict(settings),
    });

    const controller = new BreakController(
      readContext,
      clock,
      createTimers(GLib.PRIORITY_HIGH, log),
      log,
    );
    this.controller = controller;

    const schedule = readScheduleSettings(settings);
    const scheduler = new Scheduler(
      schedule,
      controller,
      clock,
      createTimers(GLib.PRIORITY_DEFAULT, log),
      log,
    );
    this.scheduler = scheduler;
    controller.setScheduler(scheduler);

    const presence = new Presence(scheduler, schedule.idleResetMs, clock, log);
    this.presence = presence;

    const indicator = new Indicator(scheduler, settings, clock, log);
    this.indicator = indicator;
    indicator.enable();
    controller.onState((snapshot) => indicator.update(snapshot));

    this.settingsChangedId = settings.connect('changed', (_source, key) => {
      this.onSettingChanged(key);
    });

    scheduler.setEnabled(settings.get_boolean('breaks-enabled'));
    presence.enable();
    scheduler.start();
    const notifier = new Notifier(log);
    this.firstRunNotifier = notifier;
    this.showFirstRunNotice(settings, notifier);
  }

  /**
   * Once, ever: tell the user what they have just switched on. An extension
   * that covers every monitor has to say so before it does it for the first
   * time — and, in strict mode, has to say how to get out of a session that
   * will not come back.
   *
   * The wording follows `strict` as it stands at enable time, because that is
   * the mode the first break will be in; the notice is shown once and never
   * revisited, so it must not promise a Skip button that has been switched off.
   *
   * Failing here costs the notice and nothing else — `enable()` must not fall
   * over because the message tray was unhappy.
   */
  private showFirstRunNotice(settings: Gio.Settings, notifier: Notifier): void {
    try {
      if (settings.get_boolean('first-run-done')) return;
      const strict = readStrict(settings);
      const posted = notifier.postNotice(
        'hardbreak is on',
        strict
          ? 'Breaks are undismissable: no skip, no escape key. Pause or switch breaks off from ' +
              'the alarm icon in the top bar. If the screen ever stays locked, press Ctrl+Alt+F3, ' +
              'log in and run: gnome-extensions disable hardbreak@melser.org (see README).'
          : 'Breaks cover every screen until the countdown ends. The Skip button or Escape ends ' +
              'one early; turn on Strict mode in the settings to remove them. Pause or switch ' +
              'breaks off from the alarm icon in the top bar.',
      );
      if (posted) settings.set_boolean('first-run-done', true);
    } catch (err) {
      this.log('hardbreak: could not show the first-run notice', err);
    }
  }

  /** Settings fan-out. The scheduler owns re-planning; presence owns the watch. */
  private onSettingChanged(key: string): void {
    const settings = this.settings;
    const scheduler = this.scheduler;
    if (!settings || !scheduler) return;
    try {
      if (key === 'breaks-enabled') {
        scheduler.setEnabled(settings.get_boolean(key));
        return;
      }
      if (!SCHEDULE_KEYS.includes(key)) return;
      const schedule = readScheduleSettings(settings);
      scheduler.updateSettings(schedule);
      // The idle watch fires at the threshold, so it has to be re-installed.
      if (key === 'idle-reset') this.presence?.setIdleResetMs(schedule.idleResetMs);
    } catch (err) {
      this.log(`hardbreak: handling a change to ${key} failed`, err);
    }
  }

  /**
   * `assets/ideas.json` is editable by hand, so a syntax error must cost the
   * ideas and nothing else: `pickIdea` has a built-in fallback for an empty book.
   *
   * The read is asynchronous because this runs on the Shell's main loop and
   * nothing there may block on a disk (e.g.o review rule EGO-X-004). `this.ideas`
   * stays empty until the read lands; `readContext()` reads the field when a
   * break starts, which is minutes away at the very least, so the first break
   * already has the book.
   */
  private loadIdeas(log: Log): void {
    const path = `${this.path}/assets/ideas.json`;
    const file = Gio.File.new_for_path(path);
    const cancellable = new Gio.Cancellable();
    this.ideasCancellable = cancellable;

    file.load_contents_async(cancellable, (source, result) => {
      // `disable()` may have run while the read was in flight: the extension is
      // torn down, `log` is dead and `this.ideas` must stay empty.
      if (cancellable.is_cancelled() || this.settings === null) return;
      this.ideasCancellable = null;
      try {
        const [ok, bytes] = (source ?? file).load_contents_finish(result);
        if (!ok) throw new Error(`could not read ${path}`);
        this.ideas = parseIdeaBook(JSON.parse(new TextDecoder().decode(bytes)));
      } catch (err) {
        log(`hardbreak: falling back to the built-in idea, ${path} is unusable`, err);
        this.ideas = emptyIdeas();
      }
    });
  }
}

/** A book with no ideas at all; `pickIdea` then uses its built-in fallback. */
function emptyIdeas(): IdeaBook {
  return { mini: [], long: [] };
}
