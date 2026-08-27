/**
 * `Gio.Settings` → the core's value types (architecture §2 and §5).
 *
 * The schema stores minutes, seconds and percent so `Gio.Settings.bind()` works
 * in prefs without mapping code; the conversion to the milliseconds/fraction
 * form the scheduler wants happens here and nowhere else.
 */

import type Gio from 'gi://Gio';

import type { ScheduleSettings } from '../core/types.js';

/** The overlay-color default, used when the setting cannot be parsed. */
const DEFAULT_COLOR = { r: 0x63, g: 0x37, b: 0x38 } as const;

/**
 * Keys that feed {@link readScheduleSettings}. A `changed` on any of them means
 * the scheduler needs a new snapshot; the remaining keys are read at break time
 * (`overlay-*`, `end-sound`, `strict`) or handled on their own (`breaks-enabled`).
 */
export const SCHEDULE_KEYS: readonly string[] = [
  'mini-interval',
  'mini-duration',
  'long-duration',
  'minis-per-long',
  'mini-warning',
  'long-warning',
  'mini-postpone',
  'long-postpone',
  'postpone-window',
  'idle-reset',
  'morning-hour',
];

/** Inline style for the per-monitor overlay covers. */
export interface OverlayStyle {
  /** A CSS `rgba(...)` colour, ready for `set_style('background-color: …')`. */
  rgba: string;
}

const MINUTE_MS = 60_000;

export function readScheduleSettings(gs: Gio.Settings): ScheduleSettings {
  return {
    miniIntervalMs: gs.get_int('mini-interval') * MINUTE_MS,
    miniDurationMs: gs.get_int('mini-duration') * 1000,
    longDurationMs: gs.get_int('long-duration') * 1000,
    minisPerLong: gs.get_int('minis-per-long'),
    miniWarningMs: gs.get_int('mini-warning') * 1000,
    longWarningMs: gs.get_int('long-warning') * 1000,
    miniPostponeMs: gs.get_int('mini-postpone') * MINUTE_MS,
    longPostponeMs: gs.get_int('long-postpone') * MINUTE_MS,
    postponeWindow: gs.get_int('postpone-window') / 100,
    idleResetMs: gs.get_int('idle-reset') * MINUTE_MS,
    morningHour: gs.get_int('morning-hour'),
  };
}

/**
 * The file to play when a break completes: a relative name resolves against the
 * extension's `assets/`, an absolute path is used verbatim, empty means silence.
 */
export function resolveEndSound(gs: Gio.Settings, extensionPath: string): string | null {
  const value = gs.get_string('end-sound').trim();
  if (value === '') return null;
  if (value.startsWith('/')) return value;
  return `${extensionPath}/assets/${value}`;
}

/**
 * Strict mode: no Skip button and no Escape key on the overlay. Read when a
 * break starts, like the overlay style and the sound, so a change takes effect
 * from the next break rather than under a wall that is already up.
 */
export function readStrict(gs: Gio.Settings): boolean {
  return gs.get_boolean('strict');
}

export function readOverlayStyle(gs: Gio.Settings): OverlayStyle {
  const { r, g, b } = parseHexColor(gs.get_string('overlay-color'));
  const opacity = clamp(gs.get_double('overlay-opacity'), 0, 1);
  return { rgba: `rgba(${r}, ${g}, ${b}, ${opacity.toFixed(3)})` };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Parse `#rgb` / `#rrggbb`. Anything else falls back to the default colour: a
 * typo in dconf must not produce a transparent (i.e. bypassable) overlay.
 */
function parseHexColor(value: string): { r: number; g: number; b: number } {
  let hex = value.trim().replace(/^#/, '');
  // `#abc` is `#aabbcc`, so double each digit and use the one parser below.
  if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.replace(/./g, (digit) => digit + digit);
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { ...DEFAULT_COLOR };
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}
