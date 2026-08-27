/**
 * The preferences page (spec §7).
 *
 * Runs in the Extensions app, not in gnome-shell: there is no `global` here and
 * nothing may import `gi://St`, `gi://Meta`, `gi://Shell` or any `resource:///`
 * module other than this one.
 *
 * The schema stores minutes/seconds/percent precisely so every numeric row is a
 * plain `Gio.Settings.bind()` with no mapping code.
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BUNDLED_SOUND = 'crystal-glass.wav';
const FALLBACK_COLOR = '#633738';

/** Keeps the settings object alive for as long as the bindings need it. */
interface WindowWithSettings {
  _hardbreakSettings?: Gio.Settings;
}

export default class HardbreakPreferences extends ExtensionPreferences {
  override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();
    (window as unknown as WindowWithSettings)._hardbreakSettings = settings;

    const page = new Adw.PreferencesPage({
      title: 'hardbreak',
      icon_name: 'alarm-symbolic',
    });

    page.add(buildSchedule(settings));
    page.add(buildBreak(settings, 'mini'));
    page.add(buildBreak(settings, 'long'));
    page.add(buildPostpone(settings));
    page.add(buildOverlay(settings));
    page.add(buildSound(settings, window));

    window.add(page);
    return Promise.resolve();
  }
}

// -- groups ------------------------------------------------------------------

function buildSchedule(settings: Gio.Settings): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({
    title: 'Schedule',
    description: 'Breaks alternate between mini and long according to the count below.',
  });
  group.add(
    switchRow(settings, 'breaks-enabled', {
      title: 'Breaks',
      subtitle: 'Same as the Breaks switch in the panel menu.',
    }),
  );
  group.add(
    spinRow(settings, 'mini-interval', {
      title: 'Interval between breaks',
      subtitle: 'Minutes of work between one break and the next (1–240).',
      lower: 1,
      upper: 240,
      step: 1,
    }),
  );
  group.add(
    spinRow(settings, 'minis-per-long', {
      title: 'Mini breaks between long breaks',
      subtitle: '0 makes every break long; 1 alternates mini and long (0–20).',
      lower: 0,
      upper: 20,
      step: 1,
    }),
  );
  group.add(
    spinRow(settings, 'idle-reset', {
      title: 'Natural break threshold',
      subtitle:
        'Minutes away — idle, locked or suspended — that count as a break and restart the cycle (1–120).',
      lower: 1,
      upper: 120,
      step: 1,
    }),
  );
  group.add(
    spinRow(settings, 'morning-hour', {
      title: 'Morning hour',
      subtitle: 'Local-time hour at which "Pause until tomorrow" ends (0–23).',
      lower: 0,
      upper: 23,
      step: 1,
    }),
  );
  return group;
}

function buildBreak(settings: Gio.Settings, kind: 'mini' | 'long'): Adw.PreferencesGroup {
  const label = kind === 'mini' ? 'Mini break' : 'Long break';
  const group = new Adw.PreferencesGroup({ title: label });
  group.add(
    spinRow(settings, `${kind}-duration`, {
      title: 'Duration',
      subtitle: `Seconds the ${label.toLowerCase()} overlay stays up (5–3600).`,
      lower: 5,
      upper: 3600,
      step: 5,
    }),
  );
  group.add(
    spinRow(settings, `${kind}-warning`, {
      title: 'Warning',
      subtitle: 'Seconds of notice before the break starts; 0 disables the warning (0–300).',
      lower: 0,
      upper: 300,
      step: 5,
    }),
  );
  group.add(
    spinRow(settings, `${kind}-postpone`, {
      title: 'Postponement',
      subtitle: 'Minutes the break is pushed back when postponed; 0 disables postponing (0–60).',
      lower: 0,
      upper: 60,
      step: 1,
    }),
  );
  return group;
}

function buildPostpone(settings: Gio.Settings): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({
    title: 'Postpone',
    description: 'A break can be postponed once, and only early on.',
  });
  group.add(
    spinRow(settings, 'postpone-window', {
      title: 'Postpone window',
      subtitle:
        'Percent of the break during which the button is offered; 0 disables postponing entirely (0–100).',
      lower: 0,
      upper: 100,
      step: 5,
    }),
  );
  return group;
}

function buildOverlay(settings: Gio.Settings): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({ title: 'Overlay' });

  const button = new Gtk.ColorDialogButton({
    dialog: new Gtk.ColorDialog({ with_alpha: false }),
    valign: Gtk.Align.CENTER,
  });
  const rgba = new Gdk.RGBA();
  if (!rgba.parse(settings.get_string('overlay-color'))) rgba.parse(FALLBACK_COLOR);
  button.set_rgba(rgba);
  button.connect('notify::rgba', () => {
    const value = toHex(button.get_rgba());
    if (value !== settings.get_string('overlay-color')) settings.set_string('overlay-color', value);
  });

  const colorRow = new Adw.ActionRow({
    title: 'Colour',
    subtitle: 'Background of the break overlay.',
    activatable_widget: button,
  });
  colorRow.add_suffix(button);
  group.add(colorRow);

  group.add(
    spinRow(settings, 'overlay-opacity', {
      title: 'Opacity',
      subtitle: 'How opaque the overlay is, from 0 (invisible) to 1 (solid).',
      lower: 0,
      upper: 1,
      step: 0.05,
      digits: 2,
    }),
  );
  return group;
}

function buildSound(settings: Gio.Settings, window: Adw.PreferencesWindow): Adw.PreferencesGroup {
  const group = new Adw.PreferencesGroup({
    title: 'Sound',
    description: 'Played when a break ends. Nothing is played when one starts.',
  });

  const row = new Adw.EntryRow({ title: 'End-of-break sound' });
  settings.bind('end-sound', row, 'text', Gio.SettingsBindFlags.DEFAULT);

  row.add_suffix(
    suffixButton('Choose…', 'Pick a sound file', () => {
      const dialog = new Gtk.FileDialog({ title: 'End-of-break sound' });
      dialog.open(window, null, (source, result) => {
        try {
          const file = (source as Gtk.FileDialog | null)?.open_finish(result);
          const path = file?.get_path();
          if (path) settings.set_string('end-sound', path);
        } catch (err) {
          // Cancelling raises Gtk.DialogError.DISMISSED; nothing to do.
          console.debug(`hardbreak: no sound file chosen (${String(err)})`);
        }
      });
    }),
  );
  row.add_suffix(
    suffixButton('Bundled', 'Use the bundled sound', () => {
      settings.set_string('end-sound', BUNDLED_SOUND);
    }),
  );
  row.add_suffix(
    suffixButton('Silent', 'Play nothing', () => {
      settings.set_string('end-sound', '');
    }),
  );

  group.add(row);
  return group;
}

// -- helpers -----------------------------------------------------------------

interface SpinOptions {
  title: string;
  subtitle: string;
  lower: number;
  upper: number;
  step: number;
  digits?: number;
}

/**
 * A spin row bound straight to its key. The schema's units are the row's units,
 * so `bind` needs no mapping and dconf stays readable.
 */
function spinRow(settings: Gio.Settings, key: string, options: SpinOptions): Adw.SpinRow {
  const row = new Adw.SpinRow({
    title: options.title,
    subtitle: options.subtitle,
    digits: options.digits ?? 0,
    adjustment: new Gtk.Adjustment({
      lower: options.lower,
      upper: options.upper,
      step_increment: options.step,
      page_increment: options.step * 10,
    }),
  });
  settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
  return row;
}

/** A switch bound straight to its boolean key, like {@link spinRow}. */
function switchRow(
  settings: Gio.Settings,
  key: string,
  options: { title: string; subtitle: string },
): Adw.SwitchRow {
  const row = new Adw.SwitchRow({ title: options.title, subtitle: options.subtitle });
  settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
  return row;
}

function suffixButton(label: string, tooltip: string, onClicked: () => void): Gtk.Button {
  const button = new Gtk.Button({
    label,
    tooltip_text: tooltip,
    valign: Gtk.Align.CENTER,
  });
  button.connect('clicked', onClicked);
  return button;
}

/** `Gdk.RGBA` components are 0..1 floats; the schema stores `#rrggbb`. */
function toHex(rgba: Gdk.RGBA): string {
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(rgba.red)}${channel(rgba.green)}${channel(rgba.blue)}`;
}
