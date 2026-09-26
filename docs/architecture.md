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
    calendar.ts              BusyInterval, lead shadow, calendarGateAt / nextCalendarEdge (calendar pause)
    watchdog.ts              Hard release deadline + exception guard (section 4)
    ideas.ts                 pickIdea(ideas, kind, rng)
    morning.ts               nextMorning(wallNowMs, morningHour, tz offset fn) → wall ms
    format.ts                formatCountdown(ms) → "2:59"
    *.test.ts
  shell/                     Thin GJS-facing adapters. Everything here runs inside gnome-shell.
    gjsPorts.ts              GLib-backed Clock + Timers
    settings.ts              Gio.Settings → ScheduleSettings snapshot, `changed` fan-out
    presence.ts              idle monitor + screenShield + login1 + DND → scheduler events
    calendar.ts              CalendarWatcher: watched calendars → scheduler.setBusyIntervals; busy-event rules
    eds.ts                   Evolution Data Server behind the watcher's port (dynamic gi:// imports only)
    edsSources.ts            prefs only: EDS sources over D-Bus (Sources5), no SourceRegistry
    notifier.ts              warning notifications (MessageTray)
    overlay.ts               per-monitor St actors, modal grab, countdown label, postpone + skip buttons
    breakController.ts       SchedulerEffects impl: overlay + watchdog + sound
    indicator.ts             PanelMenu.Button + menu
  extension.ts               Extension subclass: wires everything in enable(), tears down in disable()
  prefs.ts                   ExtensionPreferences (libadwaita)
schemas/org.gnome.shell.extensions.hardbreak.gschema.xml
assets/ideas.json  assets/crystal-glass.wav
metadata.json  stylesheet.css
scripts/build.ts  scripts/pack.ts  scripts/install-common.ts  scripts/install-ext.ts  scripts/uninstall-ext.ts
scripts/install-hooks.ts
```

`tsc` emits `src/**` → `dist/**` (same tree) minus `core/types.js`, which `scripts/build.ts`
deletes: `types.ts` exports types only, so the emitted module is empty and unreachable from
`extension.js`/`prefs.js`, which e.g.o rejects (EGO-P-007). The delete is guarded — the build
fails if that file ever gains a runtime statement or an importer. `scripts/build.ts` then copies
`metadata.json`, `stylesheet.css`, `LICENSE`, `assets/`, `schemas/*.xml` into `dist/` and runs
`glib-compile-schemas dist/schemas`. `scripts/install-ext.ts` **copies** `dist/` to
`~/.local/share/gnome-shell/extensions/hardbreak@melser.org` (staged in a hidden sibling directory,
then renamed into place), so a rebuild never mutates the tree a running Shell, prefs process or
Extensions app is reading.
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
| `watched-calendars` | as | `[]` | | EDS source uids of the **watched calendars** (ticked in preferences); their timed events are **busy events** and hold the **calendar pause** gate (spec §3). Uids that match no calendar are kept and ignored |

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

export type Mode = 'disabled' | 'dnd' | 'calendar' | 'away' | 'paused' | 'countdown' | 'warning' | 'break';
export interface Snapshot {
  mode: Mode; nextKind: BreakKind; nextBreakAt: number | null /* monotonic ms */;
  pausedUntilWall: number | null; minisSinceLong: number;
  busyUntilWall: number | null;  /* epoch ms, inside a busy event: when the hold ends */
  busyStartsWall: number | null; /* epoch ms, inside a lead shadow: when the event begins */
}
```

Monotonic `now()` drives every deadline (GLib timeouts stop during suspend, and so does
`CLOCK_MONOTONIC`, so they stay consistent). Wall time is used only for `awayMs` (computed by
the adapter), for "pause until tomorrow", and for the calendar gate, which is always re-read
from wall time (below).

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
busyIntervals: BusyInterval[]   (wall ms, merged; from setBusyIntervals)
calendarGate: none | shadow(busyStartWall) | busy(busyUntilWall)   (as of the last sync)
timers: warning, break-start, break-end, pause-end, calendar-edge
```

`blocked = !enabled || dnd || calendar || away || pausedUntil !== null`. `mode` for the
snapshot is the first true of disabled / dnd / calendar / away / paused, else the phase.

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
  `dnd = true`; off → `dnd = false` and fresh cycle (if not otherwise blocked). During a break
  only the flag changes: a fresh cycle there would set phase `countdown` under the wall, so
  postpone and skip would be refused; the break's own end plans from the flags instead.
  (Every other `planOrIdle` caller already runs outside a break or after ending it.)
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
- **calendar gate** (`core/calendar.ts`; spec §3, ADR 0001). The **lead shadow** of a busy
  event is `[start − shadowMs, start)` with `shadowMs = warningMs(nextKind) +
  durationMs(nextKind) + 60 s` (`LEAD_SHADOW_MARGIN_MS`, a constant). The gate holds for
  `wallNow ∈ lead shadow ∪ [start, end)` — purely time-based, whatever `nextBreakAt` is —
  and chained events and shadows are one continuous hold (`busyUntilWall` is the end of the
  whole hold). `normalizeBusyIntervals` sorts, merges overlapping/touching intervals and
  drops zero-length, inverted or non-finite ones before the scheduler stores them.
- **`syncCalendar()`** re-reads the gate from `wallNow()`, re-arms the **calendar-edge**
  timer for `nextCalendarEdge − wallNow` (a monotonic timer whose callback re-reads wall
  time, so a late or early firing only re-arms), and applies a hold: countdown/warning →
  timers cleared, phase `off`, like DND; phase `off` → `remainingMs = null` (a frozen
  countdown or an owed break is dropped, because the gate's end is a fresh cycle); phase
  `break` → only state `busy` interrupts. It runs on `setBusyIntervals`, on the edge timer,
  in `planOrIdle` (so `start`, `reset`, pause end, `setEnabled(true)`, `setDnd(false)`), on
  `cameBack` (a suspend stops the edge timer, not the calendar), on `updateSettings`
  (warning and duration are the shadow), after every break end (the next kind, hence the
  shadow, may change), after a postponement, and — defensively, against wall/monotonic drift
  — at the warning and break-start timers, which then do nothing inside a hold.
- **no orphan warning**: the warning timer also asks the gate at `nextBreakAt` (mapped onto
  wall time, with the next kind's shadow). If it would hold then — a shadow beginning inside
  the warning period or exactly at `nextBreakAt` — no warning is given and nothing else
  changes: that hold starts at or before `nextBreakAt`, so the edge timer stops the countdown
  first, and `onBreakStart` re-checks when both are due at the same moment.
- **leaving the gate** → fresh cycle via `planOrIdle` (other gates may still block). Released
  while away, the frozen countdown is dropped too, so the return is a fresh cycle.
- **a busy event during a break** (only a late calendar edit can put one there) →
  `endBreak('interrupted')` (the controller's teardown, no end sound), `remainingMs = null`
  — *not owed* — phase `off`. A lead shadow does not interrupt: a break that started before
  its shadow finishes before the event by construction, and if a late edit puts an event
  inside the rest of a break, the edge timer brings the break down when the event begins.
  Postponing or skipping inside a shadow arms nothing until the gate is released; a
  lock/suspend interrupt inside a hold leaves nothing owed (the calendar wins).
- **`start()`** = fresh cycle; **`stop()`** = cancel all timers, the calendar edge included
  (extension disable). `pauseFor` and `setEnabled(false)` clear every timer but the
  calendar edge, so the gate stays current.
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
2. Overlay creation, `pushModal`, the 1-s countdown tick and the postpone/skip handlers
   run through `watchdog.guard(label, …)`.
3. `onFire` → `forceRelease(reason)`: stop UI timers, pop the modal, destroy overlay actors,
   dismiss the warning, disarm, then `scheduler.abortBreak()`.
4. Normal end (`endBreak(reason)`) uses the same teardown, then `disarm()`.

Routine source removal, signal disconnection and actor destruction use direct calls.
`Overlay.hide()` retains recovery boundaries around modal/chrome removal so actor destruction
still runs after a partial-show failure. Teardown does not call `Watchdog.guard`, which would
re-enter the scheduler mid-transition. High source priority cannot preempt a blocked Shell
main loop; the watchdog is independent of the countdown, not of the Shell process.

The 30 s margin is a constant (`WATCHDOG_MARGIN_MS`), not a setting (spec §2).

## 5. Shell adapters

- **gjsPorts** — `now = GLib.get_monotonic_time()/1000`, `wallNow = Date.now()`,
  `Timers.set = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { fn(); return GLib.SOURCE_REMOVE })`
  (the watchdog gets its own `Timers` instance using `GLib.PRIORITY_HIGH`), `clear = GLib.Source.remove`.
- **presence** — one `awayReasons: Set<'idle'|'lock'|'session'|'sleep'>` and `awaySinceWall`.
  Idle: `global.backend.get_core_idle_monitor().add_idle_watch(idleResetMs, …)` (re-installed when
  `idle-reset` changes); on fire add `'idle'` with `awaySinceWall = wallNow - idleResetMs`, and
  install a one-shot `add_user_active_watch` that removes `'idle'`. Lock: `Main.screenShield`
  `locked-changed` → add/remove `'lock'`. Session mode: `Main.sessionMode.updated` →
  add/remove `'session'` from `isLocked`. This covers blanking in `unlock-dialog` even when
  `screenShield.locked` remains false. Both reasons are retained until independently cleared.
  Sleep: `LoginManager.getLoginManager()`
  `prepare-for-sleep(aboutToSuspend)` → add/remove `'sleep'`. Transition ∅→non-empty emits
  `scheduler.wentAway()`; non-empty→∅ emits `scheduler.cameBack(wallNow - awaySinceWall)`.
  Adding `'lock'`, `'session'` or `'sleep'` additionally emits `scheduler.wentAway({ interruptBreak: true })`
  whether or not it is the ∅→non-empty transition. Re-installing the idle watch replaces
  *only* the idle watch: the one-shot user-active watch is all that can clear `'idle'`
  again, so it is left alone (and installed if `'idle'` is set and it is missing).
  DND: `new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'})`, key `show-banners`,
  `scheduler.setDnd(!showBanners)` on connect and on change.
- **notifier** — `MessageTray.getSystemSource()` + `new MessageTray.Notification({source, title,
  body, isTransient: true})`; keep the reference and `destroy()` it when the break starts.
  Also `postNotice(title, body)`: an owned non-transient `Urgency.CRITICAL` notification,
  used once for the first-run notice. The extension owns a separate `Notifier` for this
  notice and destroys it on disable. Tray-side destruction clears either reference;
  the shared system source is never destroyed by the extension. Failed posting cleans up
  the notification and leaves `first-run-done` false so a later enable can retry.
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
  `startBreak` refuses to raise the wall while `Main.screenShield.locked` or
  `Main.sessionMode.isLocked` — it is top
  chrome, so it would cover the unlock dialog.
- **breakController** — implements `SchedulerEffects`; owns overlay, watchdog, sound
  (`global.display.get_sound_player().play_from_file(...)` with an owned cancellable,
  on `'completed'` only — a skipped break plays nothing) and the idea pick. Disable,
  replacement playback and playback failures cancel the sound request. `BreakContext`
  carries `strict`; `startBreak` passes `context.strict ? null : () => this.onSkip()`, where
  `onSkip` is `watchdog.guard('skip', () => scheduler.skip()) === true`, the same shape as
  postpone. `BreakSchedulerTarget` is therefore `postpone` + `skip` + `abortBreak`.
- **calendar** (`shell/calendar.ts` + `shell/eds.ts`; ADR 0001) — `CalendarWatcher` keeps
  `scheduler.setBusyIntervals()` in step with the **watched calendars**. It talks to EDS
  through a small port (`CalendarBackend` → `CalendarSource.connect()` →
  `CalendarConnection.fetch()/watch()`), so its lifecycle is unit-tested with fakes; `eds.ts`
  implements the port with GObject introspection.
  - **Loading.** Nothing is loaded until `watched-calendars` is non-empty. `eds.ts` has no
    static import of an EDS typelib: `gi://ECal?version=2.0`, `gi://EDataServer?version=1.2`
    and `gi://ICalGLib?version=3.0` come in through dynamic `import()` (GJS 1.88 rejects a
    missing typelib catchably). If that fails the watcher logs one warning and stays inert: it
    never calls the scheduler, and breaks run as if no calendar were watched.
  - **No `EDataServer.SourceRegistry`, in either process.** `source_registry_dispose()` spins
    the main context the registry was created on until nothing is pending. GJS drops the last
    reference while it destroys the JavaScript context, so a Shell that had held a registry
    segfaulted on every exit (SIGTERM → status 139 under a headless Shell 50.1; reproduced in
    plain gjs with JavaScript sources pending at exit). The Shell opens each watched calendar
    from a scratch `ESource` (`EDataServer.Source.new_with_uid(uid, null)`: in memory, no
    D-Bus); the calendar factory resolves the uid in its own registry, and a uid that is
    unknown, disabled or not a calendar just fails to open. Preferences list calendars from
    the registry *service* instead (`org.gnome.evolution.dataserver.Sources5`,
    `GetManagedObjects`, async; each source's key-file `Data` parsed with `GLib.KeyFile`).
  - **Async only, main thread only.** `ECal.Client.connect(source, EVENTS, (guint32) -1, …)`
    (do not wait for the backend to be online: its cache answers, and its `revision` bump
    after syncing reads it again), `get_object_list`, `get_timezone`: GTask-based, run in a
    worker or libecal's D-Bus thread, callback on the caller's thread-default context — the
    Shell's main loop. There is no `ECal.ClientView`: its `start()`/`stop()`/`set_flags()`
    are synchronous D-Bus calls (`e_dbus_calendar_view_call_start_sync`) with no async
    variant in libecal 3.56. Change notifications come from the client's `backend-property-changed`
    for `revision`, which the file backend and every `ECalMetaBackend` (Microsoft 365, EWS,
    CalDAV, Google) bump on each stored change; libecal emits it from an idle source on the
    client's main context (the thread-default context at `connect()`), so on the main thread.
    Identical revision values are ignored. The revision changes when EDS's *local* copy
    changes. For an online calendar that is after EDS's own sync: on first open (login),
    then every `[Refresh] IntervalMinutes` (30 for Microsoft 365), and after the network
    returns at most hourly. hardbreak does not call `ECal.Client.refresh()`, so an edit made
    on another device reaches the scheduler only after the next sync (spec §3, 2026-09-26
    addendum). `ECal.Client.generate_instances()` is not used:
    in 3.56 its callback does run on the main thread, but it resolves time zones through
    `e_cal_client_tzlookup_cb()`, which falls back to a synchronous D-Bus `GetTimezone`
    on a cache miss, and it gives JavaScript no completion signal.
  - **Reading a calendar** (`fetch(now, now + 48 h)`): (1) `get_object_list` with
    `(occur-in-time-range? …)`; (2) for every recurring series in it, every component of the
    series via `(or (uid? …) …)`, because a detached occurrence moved *out* of the window is
    not in (1) yet must cancel the occurrence its series generates inside it (the file
    backend's range query also omits detached instances, so without this pass moved-in and
    cancelled occurrences were wrong too); (3) every TZID not resolvable locally fetched with
    async `get_timezone`, which also fills the client's zone cache; (4) CPU-only expansion
    with `ECal.recur_generate_instances_sync()` (RRULE, RDATE, EXRULE, EXDATE), both
    callbacks `scope call` on the main thread, the time-zone callback answering from the
    client's cache (`ECal.TimezoneCache.get_timezone`, which also maps aliases onto libical's
    built-in zones) and libical's built-in zones only — never D-Bus; floating times and
    unknown zones are local time (`GLib.TimeZone.new_local()`); (5) detached instances applied
    like `e_cal_client_generate_instances()` (`applyOverrides`: same RECURRENCE-ID replaces,
    moved out removes, unmatched stands alone, THISANDFUTURE/THISANDPRIOR lend status and
    transparency); (6) `busyIntervalsOf`: only timed (DATE-valued starts are all-day and
    skipped), non-empty, not `STATUS:CANCELLED`, not `TRANSP:TRANSPARENT` (Outlook's "free")
    occurrences overlapping the window, kept whole (not cut at the window edges), merged.
    Microsoft 365 events arrive with IANA TZIDs (evolution-ews maps Windows zone names through
    `windowsZones.xml`), which the client cache resolves; zone data files are read by libical
    on first use of a zone, a one-time few-KB read per zone per process.
  - **When.** Each calendar is read after connecting, on every `revision` change (at most one
    read in flight plus one follow-up), every 3 h (`CALENDAR_REFRESH_MS`, a timer owned by
    the watcher) with the window moved on, on `refresh()` — which the extension calls from
    presence's `cameBack`, before the scheduler hears of it — and on `watched-calendars`
    changes. The merged list goes to the scheduler only when it changed.
  - **Failure.** A failed open or read, or `backend-died`, keeps the calendar's last known
    intervals (they keep gating until they end) and logs a journal warning (a uid that will
    not open is logged once per enable). A failure gets one retry after 60 s
    (`CALENDAR_RETRY_MS`, which also covers online-account calendars that the registry creates
    shortly after login); after that the calendar waits for the next refresh. Unwatching a
    calendar drops its intervals. Every callback is wrapped so nothing is thrown into the main
    loop.
  - **Teardown.** `disable()` bumps a generation token that every async continuation checks,
    cancels the one `Gio.Cancellable` shared by all calls, disconnects every client signal and
    clears both timers. Dropped clients are closed by libecal's dispose with a no-reply D-Bus
    call.
- **indicator** — `PanelMenu.Button(0.0, 'hardbreak', false)` with an `St.Icon`
  (`alarm-symbolic`, `system-status-icon`); style class `hardbreak-paused` (dimmed in
  `stylesheet.css`) whenever mode ≠ countdown/warning. The status line reads "Busy until
  HH:MM" in a busy event and "Busy at HH:MM" in a lead shadow — a time, never the event's
  title. Menu, top to bottom: status line
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
- **extension.ts** — `enable()`: settings → scheduler → controller → calendar watcher →
  presence (its target forwards to the scheduler, and `cameBack` calls `calendar.refresh()`
  first) → indicator → `scheduler.start()` → `calendar.enable(watched-calendars)` → the
  first-run notice (`first-run-done`, guarded: it must never fail
  `enable()`; its wording follows `readStrict(settings)` at enable time, since it is shown
  once and must not promise a Skip button that is switched off). `readContext()` fills
  `strict` alongside the other break-time fields. `assets/ideas.json` is read with
  `Gio.File.load_contents_async` under a `Gio.Cancellable` — no synchronous IO on the main
  loop (EGO-X-004) — so `ideas` starts empty and is filled when the read lands; the callback
  does nothing if it fires after teardown. `watched-calendars` changes go to
  `calendar.setWatched()`. `disable()`: reverse order;
  `controller.forceRelease('disable')` if a break is running; presence, then the calendar
  watcher, torn down before `scheduler.stop()`; disconnect every signal; cancel
  the idea-book read; destroy the first-run notifier; null every field (GNOME review rules).
- **prefs.ts** — first group is **Enforcement**, an `Adw.SwitchRow` bound to `strict`; its
  subtitle says the change applies from the next break and repeats the Ctrl+Alt+F3 recovery,
  because this is the switch that removes every other way out of a running break. The
  **Breaks** switch stays in the Schedule group. After Schedule comes **Calendar**: one
  `Adw.SwitchRow` per enabled EDS calendar (title: its name; subtitle: its account, or "On
  this computer"), adding or removing its uid in `watched-calendars` and keeping every other
  entry, known or not. The list is read asynchronously (`readSourceRecords` in
  `edsSources.ts`, then `calendarChoices` in `calendar.ts`); a spinner row shows meanwhile, and one inert row replaces it when the
  introspection data is missing ("Needs gir1.2-ecal-2.0, gir1.2-edataserver-1.2 and
  gir1.2-ical-3.0"), when EDS cannot be reached, or when there is no calendar.

## 6. Tooling

`package.json` scripts (check-default):

| script | command |
|---|---|
| `format` / `format:write` | `oxfmt --check .` / `oxfmt .` |
| `lint` / `lint:fix` | `oxlint` / `oxlint --fix` |
| `typecheck` | `tsc --noEmit -p tsconfig.tooling.json && tsc --noEmit -p tsconfig.build.json && tsc -p tsconfig.shell-tests.json` |
| `test` | `bun test` |
| `check` | typecheck + lint + test |
| `validate` | format + check (pre-commit hook, installed by `prepare`) |
| `build` | `bun run scripts/build.ts` — tsc, drop the unreachable `core/types.js`, copy assets/schema, `glib-compile-schemas` |
| `pack` | `bun run scripts/pack.ts` — build, stamp `version-name` into `dist/metadata.json` from `git describe` (exact tag → `1.0.1`, otherwise `1.0.0.3.g5f69238`; leading `v` stripped, sanitised to `[A-Za-z0-9 .]`, ≤16 chars, at least one letter or digit — numeric `version` is omitted for EGO to assign), then `gnome-extensions pack` (or a plain `zip` where that tool is absent) into `tmp/pack/`, then verify the bundle against an explicit required/forbidden file list (`core/types.js` is on the forbidden side) |
| `install:ext` / `uninstall:ext` | copy `dist/` into / remove `~/.local/share/gnome-shell/extensions/hardbreak@melser.org` (`scripts/install-common.ts`: stage as a hidden sibling, `rename(2)` into place; an old-style symlink is unlinked, a directory is replaced only if its `metadata.json` carries our uuid) |
| `devkit` | `dbus-run-session --config-file=tmp/devkit/dbus/session.conf -- gnome-shell --devkit`, after installing `dist/` (the preflight *is* `install:ext`, so the nested Shell runs the current build). The generated config `<include>`s the stock `/usr/share/dbus-1/session.conf` behind a service dir of stubs: `org.gnome.OnlineAccounts` and `org.freedesktop.secrets` run `/bin/false`, so they fail at once (a spawn failure, never `ServiceUnknown`, which would make EDS's Online Accounts module delete GOA-backed sources); every `org.gnome.evolution.dataserver.*` service found in the standard session service dirs runs its own `Exec` through `env` with `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_DATA_HOME` under `tmp/devkit/eds/` and `GSETTINGS_BACKEND=memory`. The devkit's EDS therefore starts with only its built-in sources (a devkit-local "Personal" calendar), has no online-account calendars, and never touches the live `~/.config/evolution`, `~/.cache/evolution`, `~/.local/share/evolution` or `~/.config/goa-1.0`. `devkit:reset` deletes `tmp/devkit/eds/` along with the devkit dconf db |
| `logs` | `journalctl -f -o cat /usr/bin/gnome-shell` |

(`install`/`uninstall` from spec §8 are named `install:ext`/`uninstall:ext` because bun treats a
root `install` script as a lifecycle hook of `bun install`.)

Development dependencies (nothing is bundled; GJS loads the emitted JavaScript). Versions were
checked with `bun info <pkg> version` on 2026-09-25; `packageManager` is `bun@1.4.2`, the
bun that `mise.toml`'s `bun = "1.4"` resolves to.

| package | version | note |
|---|---|---|
| `typescript` | 7.0.2 | latest |
| `oxlint` / `oxfmt` | 1.85.0 / 0.70.0 | latest |
| `@types/bun` | 1.4.2 | latest |
| `@girs/gnome-shell` | 50.0.4 | latest; the 50.x line matches the installed Shell 50.1 |
| `@girs/gjs`, `@girs/adw-1`, `@girs/gtk-4.0`, `@girs/ecal-2.0`, `@girs/edataserver-1.2`, `@girs/icalglib-3.0` | 4.9.0 | **pinned below the latest (5.4.0)** — see below |

The `@girs` pin: `@girs/gnome-shell@50.0.4` depends on `@girs/*@^4.1.0`, and no Shell-50
typings exist on the 5.x line. Installing the 5.x packages at the root puts two copies of the
GObject/Gio/GLib typings in one program, with two `declare module 'gi://Gio'` that TypeScript
merges silently: under the project's ambient imports a signal name that `@girs/gio-2.0@5.4.0`
alone rejects type-checks again. Every `@girs` package therefore stays on 4.9.0, the latest
4.x, so the tree holds one coherent copy. Move them to 5.x together once a 5.x-based
`@girs/gnome-shell` is published. The three EDS typings are only for `import type`: the
typelibs are loaded at runtime with dynamic `import()` (section 5, calendar).

CI (`.github/workflows/`): `ci.yml` runs `validate` + `pack` on pushes to `develop`/`main` and on
pull requests and uploads the zip; `release.yml` does the same on a `v*` tag and attaches the zip
to a GitHub release with the tag message as the notes.

`src/shell/ambient.d.ts` adds the `@girs/ecal-2.0`, `@girs/edataserver-1.2` and
`@girs/icalglib-3.0` ambient modules to the runtime and Shell-test projects.

The root `tsconfig.json` is a solution configuration referencing the three projects so
editors can discover them. `tsconfig.tooling.json` covers `src/core/**` including tests and
`scripts/**` with Bun types. `tsconfig.build.json` covers runtime `src/**` minus tests with
`types: []` and the `@girs` ambient imports, `rootDir: src`, `outDir: dist`, `target: ESNext`,
`module/moduleResolution: NodeNext`, `verbatimModuleSyntax`, `strict` and `noEmitOnError`.
`tsconfig.shell-tests.json` adds Bun types for the mocked Shell adapter tests without
emitting anything. `typecheck` checks each project explicitly; it does not use `tsc --build`.
