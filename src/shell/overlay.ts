/**
 * The break overlay: the wall (architecture §5, spec §2 and §4).
 *
 * One full-monitor cover per monitor, all inside a single group that owns the
 * modal grab, so releasing input is one `popModal` call however many monitors
 * are attached. There is no dismiss, no escape chord and no end-early key: key
 * events that reach the group are swallowed. The only way out other than the
 * countdown is the watchdog calling {@link Overlay.hide}.
 *
 * The postpone button is therefore **mouse only**: the modal grab gives key
 * focus to the group, whose key handlers stop every event before it can reach a
 * child, so there is no keyboard route to the button by construction.
 *
 * Anything the Shell calls into here that could leave the grab in place — the
 * `monitors-changed` rebuild above all — reports through `onError` so the
 * watchdog releases instead of the failure being merely logged.
 */

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { formatCountdown } from '../core/format.js';
import type { BreakRequest, Idea, Log } from '../core/types.js';
import type { OverlayStyle } from './settings.js';

interface Shown {
  request: BreakRequest;
  idea: Idea;
  style: OverlayStyle;
  /** How far the break is pushed back, for the button label. */
  postponeMs: number;
  onPostpone: () => boolean;
}

export class Overlay {
  private group: St.Widget | null = null;
  private grab: Clutter.Grab | null = null;
  private monitorsChangedId = 0;

  private shown: Shown | null = null;
  private countdownLabels: St.Label[] = [];
  private postponeButtons: St.Button[] = [];

  private remainingMs = 0;
  private postponeOffered = false;
  private postponeUsed = false;

  constructor(
    private readonly log: Log,
    /**
     * Reported failures reach the watchdog (log + fire → force release). Only
     * for failures that may have left the modal grabbed; per-actor cosmetic
     * failures are logged and isolated instead.
     */
    private readonly onError: (label: string, err: unknown) => void,
  ) {}

  /** Whether anything is currently on screen (and therefore grabbing input). */
  get visible(): boolean {
    return this.group !== null;
  }

  /**
   * Put the wall up. The caller runs this inside `Watchdog.guard`, so a throw
   * anywhere below releases the modal instead of trapping the session.
   */
  show(
    request: BreakRequest,
    idea: Idea,
    style: OverlayStyle,
    postponeMs: number,
    onPostpone: () => boolean,
  ): void {
    if (this.group) this.hide();

    this.shown = { request, idea, style, postponeMs, onPostpone };
    this.remainingMs = request.durationMs;
    this.postponeOffered = request.postponeAllowed && postponeMs > 0;
    this.postponeUsed = false;

    const group = new St.Widget({
      name: 'hardbreakOverlay',
      style_class: 'hardbreak-group',
      reactive: true,
      can_focus: true,
    });
    group.add_constraint(
      new Clutter.BindConstraint({
        source: global.stage,
        coordinate: Clutter.BindCoordinate.ALL,
      }),
    );
    // Hard enforcement: nothing typed while the wall is up does anything. With
    // ActionMode.NONE the Shell's own keybindings (including Super) are already
    // rejected; this stops everything else that bubbles up to the group.
    group.connect('key-press-event', () => Clutter.EVENT_STOP);
    group.connect('key-release-event', () => Clutter.EVENT_STOP);

    // Assigned before the Shell calls below so that a throw in any of them
    // still leaves `hide()` able to clean the actor up.
    this.group = group;
    // No params: Shell 50's chrome tracker only knows `trackFullscreen` and
    // `affectsStruts`, and rejects anything else ("Unrecognized parameter").
    Main.layoutManager.addTopChrome(group);
    this.buildMonitors();
    this.grab = Main.pushModal(group, { actionMode: Shell.ActionMode.NONE });

    // Not merely logged: `buildMonitors` destroys the existing covers first, so
    // a throw halfway through leaves a stage-sized, invisible actor holding the
    // grab — exactly what the watchdog exists for.
    this.monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
      try {
        this.buildMonitors();
      } catch (err) {
        this.onError('the overlay rebuild for a monitor change', err);
      }
    });
  }

  /** Countdown repaint, driven by the controller's 1-second tick. */
  tick(remainingMs: number): void {
    this.remainingMs = Math.max(0, remainingMs);
    const text = formatCountdown(this.remainingMs);
    for (const label of this.countdownLabels) {
      try {
        label.set_text(text);
      } catch (err) {
        this.log('hardbreak: could not update a countdown label', err);
      }
    }
  }

  /** The postpone window has elapsed (or the button has been used). */
  hidePostpone(): void {
    this.postponeOffered = false;
    for (const button of this.postponeButtons) {
      try {
        button.visible = false;
      } catch (err) {
        this.log('hardbreak: could not hide a postpone button', err);
      }
    }
  }

  /**
   * Take the wall down. Idempotent, and every step is isolated: a failure to
   * remove the chrome must not stop the modal from being popped, because the
   * grab is what holds the session.
   */
  hide(): void {
    const grab = this.grab;
    this.grab = null;
    if (grab) {
      try {
        Main.popModal(grab);
      } catch (err) {
        this.log('hardbreak: popModal failed', err);
      }
    }

    const monitorsChangedId = this.monitorsChangedId;
    this.monitorsChangedId = 0;
    if (monitorsChangedId !== 0) {
      try {
        Main.layoutManager.disconnect(monitorsChangedId);
      } catch (err) {
        this.log('hardbreak: failed to disconnect monitors-changed', err);
      }
    }

    const group = this.group;
    this.group = null;
    this.shown = null;
    this.countdownLabels = [];
    this.postponeButtons = [];
    this.postponeOffered = false;
    if (group) {
      try {
        Main.layoutManager.removeChrome(group);
      } catch (err) {
        this.log('hardbreak: removeChrome failed', err);
      }
      try {
        group.destroy();
      } catch (err) {
        this.log('hardbreak: destroying the overlay group failed', err);
      }
    }
  }

  // -- actors ----------------------------------------------------------------

  /** (Re)create one cover per monitor. Also the `monitors-changed` handler. */
  private buildMonitors(): void {
    const group = this.group;
    const shown = this.shown;
    if (!group || !shown) return;

    group.destroy_all_children();
    this.countdownLabels = [];
    this.postponeButtons = [];

    for (const monitor of Main.layoutManager.monitors) {
      const cover = new St.Widget({
        style_class: 'hardbreak-overlay',
        reactive: true,
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
        layout_manager: new Clutter.BinLayout(),
      });
      cover.set_style(`background-color: ${shown.style.rgba};`);
      cover.add_child(this.buildContent(shown));
      group.add_child(cover);
    }
  }

  private buildContent(shown: Shown): St.BoxLayout {
    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: 'hardbreak-content',
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
      y_expand: true,
    });

    const countdown = new St.Label({
      style_class: 'hardbreak-countdown',
      text: formatCountdown(this.remainingMs),
      x_align: Clutter.ActorAlign.CENTER,
    });
    this.countdownLabels.push(countdown);
    box.add_child(countdown);

    if (shown.idea.title !== undefined && shown.idea.title !== '') {
      box.add_child(
        this.wrapping(
          new St.Label({
            style_class: 'hardbreak-idea-title',
            text: shown.idea.title,
            x_align: Clutter.ActorAlign.CENTER,
          }),
        ),
      );
    }
    box.add_child(
      this.wrapping(
        new St.Label({
          style_class: 'hardbreak-idea-body',
          text: shown.idea.body,
          x_align: Clutter.ActorAlign.CENTER,
        }),
      ),
    );

    if (shown.request.postponeAllowed && shown.postponeMs > 0) {
      const minutes = Math.max(1, Math.round(shown.postponeMs / 60_000));
      // No `can_focus`: the group owns key focus under the modal grab and eats
      // every key event, so the button is mouse-only by construction and a
      // focus ring it can never show would only be misleading.
      const button = new St.Button({
        label: `Postpone ${minutes} min`,
        style_class: 'hardbreak-postpone',
        x_align: Clutter.ActorAlign.CENTER,
      });
      button.visible = this.postponeOffered && !this.postponeUsed;
      button.connect('clicked', () => this.onPostponeClicked());
      this.postponeButtons.push(button);
      box.add_child(button);
    }

    return box;
  }

  private wrapping(label: St.Label): St.Label {
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return label;
  }

  /**
   * Note that a granted postponement tears this overlay down synchronously
   * (scheduler → `endBreak('postponed')` → controller teardown), so nothing may
   * touch the actors afterwards.
   */
  private onPostponeClicked(): void {
    if (this.postponeUsed || !this.postponeOffered) return;
    const onPostpone = this.shown?.onPostpone;
    if (!onPostpone) return;
    this.postponeUsed = true;
    let granted = false;
    try {
      granted = onPostpone();
    } catch (err) {
      // The controller already guards `postpone`, so reaching this means the
      // guard itself failed: the wall may be up with a half-applied transition
      // behind it, which is the watchdog's business, not a log line's.
      this.onError('the postpone handler', err);
    }
    if (!granted && this.group) this.hidePostpone();
  }
}
