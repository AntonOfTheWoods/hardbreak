# hardbreak — architecture

Companion to [spec.md](spec.md) (which wins on any conflict). This file fixes the module
boundaries, the settings keys, the scheduler state machine and the safety contract so the
code can be written and reviewed against something concrete.

## 1. Module map

```
src/
  core/                      GJS-free. Unit-tested with `bun test`. No `gi://`, no `resource:///`.
    types.ts                 Clock / Timers ports, BreakKind, ScheduleSettings, SchedulerEffects, Snapshot
    scheduler.ts             The state machine (section 3)
    watchdog.ts              Hard release deadline + exception guard (section 4)
    ideas.ts                 pickIdea(ideas, kind, rng)
    morning.ts               nextMorning(wallNowMs, morningHour, tz offset fn) → wall ms
    format.ts                formatCountdown(ms) → "2:59"
    *.test.ts
  shell/                     Thin GJS-facing adapters. Everything here runs inside gnome-shell.
    gjsPorts.ts              GLib-backed Clock + Timers
    settings.ts              Gio.Settings → ScheduleSettings snapshot, `changed` fan-out
    presence.ts              idle monitor + screenShield + login1 + DND → scheduler events
    notifier.ts              warning notifications (MessageTray)
    overlay.ts               per-monitor St actors, modal grab, countdown label, postpone + skip buttons
    breakController.ts       SchedulerEffects impl: overlay + watchdog + sound
    indicator.ts             PanelMenu.Button + menu
  extension.ts               Extension subclass: wires everything in enable(), tears down in disable()
  prefs.ts                   ExtensionPreferences (libadwaita)
schemas/org.gnome.shell.extensions.hardbreak.gschema.xml
assets/ideas.json  assets/crystal-glass.wav
metadata.json  stylesheet.css
scripts/build.ts  scripts/pack.ts  scripts/install-ext.ts  scripts/uninstall-ext.ts  scripts/install-hooks.ts
```

`tsc` emits `src/**` → `dist/**` (same tree) minus `core/types.js`, which `scripts/build.ts`
deletes: `types.ts` exports types only, so the emitted module is empty and unreachable from
`extension.js`/`prefs.js`, which e.g.o rejects (EGO-P-007). The delete is guarded — the build
fails if that file ever gains a runtime statement or an importer. `scripts/build.ts` then copies
`metadata.json`, `stylesheet.css`, `assets/`, `schemas/*.xml` into `dist/` and runs
`glib-compile-schemas dist/schemas`. `dist/` is symlinked to `~/.local/share/gnome-shell/extensions/hardbreak@melser.org`.
Relative imports are written with `.js` extensions (`./core/scheduler.js`) so the emitted ESM
loads unmodified in GJS.

## 2. Settings — `org.gnome.shell.extensions.hardbreak`, path `/org/gnome/shell/extensions/hardbreak/`

Units are chosen so `Gio.Settings.bind()` works without mapping code in prefs.

| key | type | default | range | unit / meaning |
|---|---|---|---|---|
| `mini-interval` | i | 30 | 1..240 | minutes between breaks |
| `mini-duration` | i | 60 | 5..3600 | seconds |
| `long-duration` | i | 180 | 5..3600 | seconds |
| `minis-per-long` | i | 1 | 0..20 | minis between long breaks; 0 = every break is long |
| `mini-warning` | i | 10 | 0..300 | seconds; 0 = no warning |
| `long-warning` | i | 30 | 0..300 | seconds; 0 = no warning |
| `mini-postpone` | i | 2 | 0..60 | minutes; 0 = postpone disabled for minis |
| `long-postpone` | i | 5 | 0..60 | minutes; 0 = disabled for longs |
| `postpone-window` | i | 30 | 0..100 | percent of the break during which postpone is offered |
| `idle-reset` | i | 5 | 1..120 | minutes away (idle / locked / asleep) that count as a break |
| `morning-hour` | i | 6 | 0..23 | "pause until tomorrow" target hour (local time) |
| `overlay-color` | s | `#633738` | | CSS hex colour |
| `overlay-opacity` | d | 0.9 | 0..1 | |
| `end-sound` | s | `crystal-glass.wav` | | relative → `<extension dir>/assets/<name>`; absolute path used verbatim; empty = silent |
| `strict` | b | false | | no Skip button and no Escape during a break; read at break start, so it applies from the next break. Off (the default) is *soft mode*: the same modal wall, plus a Skip button and Escape |
| `breaks-enabled` | b | true | | the panel-menu Disable toggle; persisted so a Shell restart keeps the choice |
| `first-run-done` | b | false | | set by `enable()` after the one-off notice explaining what a break does (and, in strict mode, that it cannot be skipped and how to recover a wedged session); set back to false to see it again |

`ScheduleSettings` (core) is the milliseconds/fraction form of the eleven schedule keys
(`mini-interval` … `morning-hour`):

```ts
export interface ScheduleSettings {
  miniIntervalMs: number; miniDurationMs: number; longDurationMs: number; minisPerLong: number;
  miniWarningMs: number; longWarningMs: number; miniPostponeMs: number; longPostponeMs: number;
  postponeWindow: number;   // 0..1
  idleResetMs: number; morningHour: number;
}
```

## 3. Scheduler (`core/scheduler.ts`)

### Ports

```ts
export interface Clock { now(): number /* monotonic ms */; wallNow(): number /* epoch ms */ }
export type TimerHandle = number & { readonly __brand: 'TimerHandle' }; // or an opaque object
export interface Timers { set(ms: number, fn: () => void): TimerHandle; clear(h: TimerHandle): void }
export type BreakKind = 'mini' | 'long';
export type BreakEndReason = 'completed' | 'postponed' | 'interrupted' | 'aborted' | 'skipped';

export interface SchedulerEffects {
  warn(kind: BreakKind, secondsUntil: number): void;
  startBreak(b: { kind: BreakKind; durationMs: number; postponeAllowed: boolean; postponeWindowMs: number }): void;
  endBreak(reason: BreakEndReason): void;      // 'completed' is the only reason that plays the sound
  stateChanged(s: Snapshot): void;             // indicator refresh; cheap, no per-second calls
}

export type Mode = 'disabled' | 'dnd' | 'away' | 'paused' | 'countdown' | 'warning' | 'break';
export interface Snapshot {
  mode: Mode; nextKind: BreakKind; nextBreakAt: number | null /* monotonic ms */;
  pausedUntilWall: number | null; minisSinceLong: number;
}
```

Monotonic `now()` drives every deadline (GLib timeouts stop during suspend, and so does
`CLOCK_MONOTONIC`, so they stay consistent). Wall time is used only for `awayMs` (computed by
the adapter) and for "pause until tomorrow".

### State

```
enabled: boolean          (breaks-enabled)
dnd: boolean              (show-banners == false)
away: boolean             (locked, asleep, or idle ≥ idle-reset)
pausedUntil: monotonic|null
phase: 'countdown' | 'warning' | 'break' | 'off'
cycleStartedAt, nextBreakAt: monotonic
remainingMs: number|null  (frozen countdown while away)
minisSinceLong: number
postponedThisBreak: boolean
breakKind, breakStartedAt, breakDurationMs
timers: warning, break-start, break-end, pause-end
```

`blocked = !enabled || dnd || away || pausedUntil !== null`. `mode` for the snapshot is the
first true of disabled / dnd / away / paused, else the phase.

### Rules

- **fresh cycle**: `minisSinceLong = 0`, `postponedThisBreak = false`, `cycleStartedAt = now`,
  `nextBreakAt = now + miniIntervalMs`, phase `countdown`, timers re-armed. `nextKind` =
  `minisSinceLong >= minisPerLong ? 'long' : 'mini'` (so `minisPerLong = 1` alternates,
  `0` makes every break long).
- **arming**: warning timer at `nextBreakAt - warningMs(kind)` if that is `>= now` and
  `warningMs > 0`; break-start timer at `nextBreakAt`. (`>=`, not `>`: an interrupted
  break resumes with exactly its warning left, and that warning must still be given.)
- **warning timer** → phase `warning`, `effects.warn(kind, ceil((nextBreakAt-now)/1000))`.
- **break-start timer** → phase `break`; `breakStartedAt = now`; `postponeAllowed =
  !postponedThisBreak && postponeMs(kind) > 0 && postponeWindow > 0`; `effects.startBreak(...)`;
  break-end timer at `now + durationMs(kind)`.
- **break-end timer** → `effects.endBreak('completed')`; advance: long → `minisSinceLong = 0`,
  mini → `minisSinceLong += 1`; `postponedThisBreak = false`; `cycleStartedAt = now`;
  `nextBreakAt = now + miniIntervalMs`; arm.
- **`postpone()`** (from the overlay button): returns `false` unless phase is `break`,
  `!postponedThisBreak`, and `now < breakStartedAt + durationMs * postponeWindow`. On success:
  `effects.endBreak('postponed')`, `postponedThisBreak = true`, counters untouched (same kind
  comes back), `nextBreakAt = now + postponeMs(kind)`, arm (warning included).
- **`skip()`** (soft mode's Skip button or Escape; strict mode never offers either): returns
  `false` unless phase is `break`. On success: cancel the break-end timer,
  `effects.endBreak('skipped')`, then advance exactly as `completed` — a skipped break is
  spent, not owed, so the alternation carries on and the next interval runs from the skip.
  The scheduler knows nothing about `strict`: the controller decides whether the overlay is
  given any way to call this. `'skipped'` is never treated as `'completed'` (no end sound).
- **`abortBreak()`** (watchdog fired or overlay threw): if phase is `break`, cancel the
  break-end timer, `effects.endBreak('aborted')`, then advance exactly as `completed` (the
  user has had the wall for at least the full duration by the time the watchdog fires).
- **`wentAway(options?: { interruptBreak?: boolean })`**: if countdown/warning →
  `remainingMs = nextBreakAt - now`, cancel timers, phase `off`, `away = true`. If in a
  break → just `away = true` and the break continues, *unless* `interruptBreak` is set.
  Idle never sets it (idle is exactly what the wall makes you); lock and suspend always do,
  because the wall must never be left behind the unlock dialog and a closed lid must not
  become a skipped break. With `interruptBreak` and phase `break`: cancel the break-end
  timer, `effects.endBreak('interrupted')`, `remainingMs = warningMs(kind)` for the break
  that was cut short, `minisSinceLong` / `postponedThisBreak` untouched (the same break is
  owed), phase `off`, `away = true`. `cameBack` then decides: `>= idleResetMs` → fresh
  cycle, shorter → `resumeCountdown()`, i.e. the warning immediately and the same break
  right behind it. The interrupt is not conditional on `away` already being false: by the
  time the screen locks, the idle watch has usually fired already.
- **`cameBack(awayMs)`**: `away = false`. If `awayMs >= idleResetMs`: in a break →
  `effects.endBreak('interrupted')` then fresh cycle; otherwise fresh cycle. If `awayMs <
  idleResetMs`: in a break → nothing; otherwise `nextBreakAt = now + remainingMs`, arm
  (a warning that would already be in the past is skipped).
- **`setDnd(on)`**: on → like `wentAway` for countdown/warning (break continues) but with
  `dnd = true`; off → `dnd = false` and fresh cycle (if not otherwise blocked).
- **`pauseFor(ms)` / `pauseUntilWall(wallMs)`**: cancel countdown timers, phase `off`,
  `pausedUntil = now + ms` (wall variant converts via `wallMs - wallNow()`), pause-end timer
  → `pausedUntil = null` + fresh cycle. Ignored during a break (the modal makes the menu
  unreachable anyway).
- **`reset()`**: clears `pausedUntil`, then fresh cycle (if not blocked by disabled/dnd/away).
- **`setEnabled(on)`**: off → cancel everything (a running break is ended with
  `'interrupted'` — this is the only user-reachable early end and it is only reachable via
  dconf/prefs, not the overlay), phase `off`; on → fresh cycle.
- **`updateSettings(s)`**: replace settings; if countdown/warning, re-plan from
  `cycleStartedAt`: `nextBreakAt = max(now + 1000, cycleStartedAt + miniIntervalMs)`, arm.
  Never touches a running break.
- **`start()`** = fresh cycle; **`stop()`** = cancel all timers (extension disable).
- Every transition ends with `effects.stateChanged(snapshot())` (debounce not needed; it is
  called on transitions only, never per second).
- Timer callbacks run through a `safe()` wrapper: any exception is logged via an injected
  `log(err)` and, if a break is running, converted to `abortBreak()`.

## 4. Watchdog (`core/watchdog.ts`) — the most important code in the repo

```ts
export class Watchdog {
  constructor(timers: Timers, onFire: (reason: string) => void, log: (msg: string, err?: unknown) => void)
  arm(ms: number): void          // re-arm replaces the previous deadline
  disarm(): void
  guard<T>(label: string, fn: () => T): T | undefined   // try/catch → log + fire(`exception in ${label}`)
  readonly armed: boolean
}
```

`fire` runs at most once per `arm()`. `BreakController` uses it as follows:

1. `watchdog.arm(durationMs + 30_000)` **before** anything touches the Shell.
2. Overlay creation, `pushModal`, the 1-s countdown tick, the postpone handler and the
   teardown are each wrapped in `watchdog.guard(label, …)`.
3. `onFire` → `forceRelease(reason)`: pop the modal, destroy every overlay actor, disarm —
   each step in its own try/catch so one failure cannot prevent the others — then
   `scheduler.abortBreak()`.
4. Normal end (`endBreak(reason)`) → `disarm()` then the same teardown.

The 30 s margin is a constant (`WATCHDOG_MARGIN_MS`), not a setting (spec §2).

## 5. Shell adapters

- **gjsPorts** — `now = GLib.get_monotonic_time()/1000`, `wallNow = Date.now()`,
  `Timers.set = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { fn(); return GLib.SOURCE_REMOVE })`
  (the watchdog gets its own `Timers` instance using `GLib.PRIORITY_HIGH`), `clear = GLib.Source.remove`.
- **presence** — one `awayReasons: Set<'idle'|'lock'|'sleep'>` and `awaySinceWall`.
  Idle: `global.backend.get_core_idle_monitor().add_idle_watch(idleResetMs, …)` (re-installed when
  `idle-reset` changes); on fire add `'idle'` with `awaySinceWall = wallNow - idleResetMs`, and
  install a one-shot `add_user_active_watch` that removes `'idle'`. Lock: `Main.screenShield`
  `locked-changed` → add/remove `'lock'`. Sleep: `LoginManager.getLoginManager()`
  `prepare-for-sleep(aboutToSuspend)` → add/remove `'sleep'`. Transition ∅→non-empty emits
  `scheduler.wentAway()`; non-empty→∅ emits `scheduler.cameBack(wallNow - awaySinceWall)`.
  Adding `'lock'` or `'sleep'` additionally emits `scheduler.wentAway({ interruptBreak: true })`
  whether or not it is the ∅→non-empty transition. Re-installing the idle watch replaces
  *only* the idle watch: the one-shot user-active watch is all that can clear `'idle'`
  again, so it is left alone (and installed if `'idle'` is set and it is missing).
  DND: `new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'})`, key `show-banners`,
  `scheduler.setDnd(!showBanners)` on connect and on change.
- **notifier** — `MessageTray.getSystemSource()` + `new MessageTray.Notification({source, title,
  body, isTransient: true})`; keep the reference and `destroy()` it when the break starts.
  Also `postNotice(title, body, log)`: a non-transient `Urgency.CRITICAL` notification that
  nothing holds a reference to, used once for the first-run notice.
- **overlay** — a reactive `St.Widget` group sized to `global.stage`, added with
  `Main.layoutManager.addTopChrome(group)` (no params — Shell 50 only accepts `trackFullscreen`/`affectsStruts`); one child per
  `Main.layoutManager.monitors` entry (`x, y, width, height`) with inline style
  `background-color: rgba(r,g,b,opacity)` from `overlay-color`/`overlay-opacity`; centred vertical
  box with countdown label, idea title + body labels, and the postpone `St.Button`. Then
  `Main.pushModal(group, {actionMode: Shell.ActionMode.NONE})` — `NONE` makes
  `WindowManager._filterKeybinding` reject every keybinding, including the overlay key. The group
  also handles `key-press-event` and returns `Clutter.EVENT_STOP`. `show(…, onSkip)` takes the
  soft-mode escape hatch as its last argument: `null` is strict mode (no Skip button, and
  `key-press-event` merely swallows Escape like everything else), non-null adds a
  `hardbreak-skip` `St.Button` below the postpone button — visible for the *whole* break,
  unlike postpone — and makes `Clutter.KEY_Escape` call it. A granted skip tears the overlay
  down synchronously, exactly like a granted postponement, so nothing may touch the actors
  afterwards. Rebuild children on
  `monitors-changed` — that rebuild destroys the existing covers first, so its failures go
  to the constructor's `onError(label, err)` (routed by `BreakController` through
  `Watchdog.guard`, i.e. log + fire → `forceRelease`) rather than to a log line, which
  would leave an invisible stage-sized actor holding the grab. Countdown tick: 1-s
  `GLib.timeout_add_seconds`, guarded. The postpone button is hidden when the window elapses
  or after use, and is **mouse only** by construction: the group owns key focus under the
  modal grab and swallows every key event, so it carries no `can_focus` and no focus style.
  `startBreak` refuses to raise the wall while `Main.screenShield.locked` — it is top
  chrome, so it would cover the unlock dialog.
- **breakController** — implements `SchedulerEffects`; owns overlay, watchdog, sound
  (`global.display.get_sound_player().play_from_file(Gio.File.new_for_path(p), 'Break over', null)`
  on `'completed'` only — a skipped break plays nothing) and the idea pick. `BreakContext`
  carries `strict`; `startBreak` passes `context.strict ? null : () => this.onSkip()`, where
  `onSkip` is `watchdog.guard('skip', () => scheduler.skip()) === true`, the same shape as
  postpone. `BreakSchedulerTarget` is therefore `postpone` + `skip` + `abortBreak`.
- **indicator** — `PanelMenu.Button(0.0, 'hardbreak', false)` with an `St.Icon`
  (`alarm-symbolic`, `system-status-icon`); style class `hardbreak-paused` (dimmed in
  `stylesheet.css`) whenever mode ≠ countdown/warning. Menu, top to bottom: status line
  (non-reactive `PopupMenuItem`, refreshed on `open-state-changed` only), separator, Pause 1 h,
  Pause 2 h, Pause until tomorrow, separator, Reset, `PopupSwitchMenuItem('Breaks')` bound to
  `breaks-enabled`. `Main.panel.addToStatusArea('hardbreak', button)`, then
  `button.container.visible = !Main.sessionMode.isLocked`, kept in sync on `Main.sessionMode`
  `updated`: `metadata.json` declares `"session-modes": ["user", "unlock-dialog"]` so the
  extension survives the lock screen, and `Panel._hideIndicators` only hides the Shell's own
  roles.
- **metadata.json** — `"session-modes": ["user", "unlock-dialog"]`. Without it the extension
  system disables every extension on lock and enables it again on unlock (`ExtensionManager`
  `_sessionUpdated`), so every lock would be a `disable()`/`enable()` pair and therefore a
  fresh cycle — `locked-changed` would never be seen and spec §3's "away < idle-reset →
  resume" would be unreachable for lock and suspend. That reason is repeated as a comment at
  the top of `disable()`, where e.g.o's review tooling looks for it (EGO-M-008).
- **extension.ts** — `enable()`: settings → scheduler → controller → presence → indicator →
  `scheduler.start()` → the first-run notice (`first-run-done`, guarded: it must never fail
  `enable()`; its wording follows `readStrict(settings)` at enable time, since it is shown
  once and must not promise a Skip button that is switched off). `readContext()` fills
  `strict` alongside the other break-time fields. `assets/ideas.json` is read with
  `Gio.File.load_contents_async` under a `Gio.Cancellable` — no synchronous IO on the main
  loop (EGO-X-004) — so `ideas` starts empty and is filled when the read lands; the callback
  does nothing if it fires after teardown. `disable()`: reverse order;
  `controller.forceRelease('disable')` if a break is running; disconnect every signal; cancel
  the idea-book read; null every field (GNOME review rules).
- **prefs.ts** — first group is **Enforcement**, an `Adw.SwitchRow` bound to `strict`; its
  subtitle says the change applies from the next break and repeats the Ctrl+Alt+F3 recovery,
  because this is the switch that removes every other way out of a running break. The
  **Breaks** switch stays in the Schedule group.

## 6. Tooling

`package.json` scripts (check-default):

| script | command |
|---|---|
| `format` / `format:write` | `oxfmt --check .` / `oxfmt .` |
| `lint` / `lint:fix` | `oxlint` / `oxlint --fix` |
| `typecheck` | `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.build.json` |
| `test` | `bun test` |
| `check` | typecheck + lint + test |
| `validate` | format + check (pre-commit hook, installed by `prepare`) |
| `build` | `bun run scripts/build.ts` — tsc, drop the unreachable `core/types.js`, copy assets/schema, `glib-compile-schemas` |
| `pack` | `bun run scripts/pack.ts` — build, then `gnome-extensions pack` (or a plain `zip` where that tool is absent) into `tmp/pack/`, then verify the bundle against an explicit required/forbidden file list (`core/types.js` is on the forbidden side) |
| `install:ext` / `uninstall:ext` | symlink / unlink `dist/` ↔ `~/.local/share/gnome-shell/extensions/hardbreak@melser.org` |
| `devkit` | `dbus-run-session -- gnome-shell --devkit` |
| `logs` | `journalctl -f -o cat /usr/bin/gnome-shell` |

(`install`/`uninstall` from spec §8 are named `install:ext`/`uninstall:ext` because bun treats a
root `install` script as a lifecycle hook of `bun install`.)

CI (`.github/workflows/`): `ci.yml` runs `validate` + `pack` on pushes to `develop`/`main` and on
pull requests and uploads the zip; `release.yml` does the same on a `v*` tag and attaches the zip
to a GitHub release with the tag message as the notes.

Two tsconfigs: `tsconfig.json` covers `src/core/**` including tests with `types: ["bun"]`;
`tsconfig.build.json` covers `src/**` minus tests with `types: []` and the `@girs` ambient
imports, `rootDir: src`, `outDir: dist`, `target/module: ESNext`, `moduleResolution: Bundler`,
`verbatimModuleSyntax`, `strict`.
