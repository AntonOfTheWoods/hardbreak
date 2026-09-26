# hardbreak — specification

Agreed 2026-08-27 in a grilling session (yxnu workspace); this file is the hand-off.
Decisions are numbered Q1–Q12 as they were made. ⚠ marks assumptions that were
stated and not objected to, not explicitly decided.

## 1. What and why

A GNOME Shell extension, UUID `hardbreak@melser.org`, that replaces
[Stretchly](https://github.com/hovancik/stretchly) 1.22.1 as Anton's break enforcer.

Stretchly is an Electron app: 5 Chromium processes, ~287 MB RSS, and "buggy" on
GNOME/Ubuntu LTS for years. The requirement is Stretchly's *behaviour as configured*
(section 4), with zero extra processes.

### Target environment (facts, checked 2026-08-27)

- Ubuntu 26.04.1 LTS, GNOME Shell 50.1, **Wayland only** — there is no X11 session on
  this machine (`/usr/share/xsessions/` does not exist; only
  `/usr/share/wayland-sessions/ubuntu.desktop`).
- gjs 1.88, bun 1.4.0. User extensions enabled (`disable-user-extensions = false`).
- Laptop panel eDP‑1 1920×1080 @ 1.25× scale; external monitors are docked sometimes
  (Stretchly `allScreens: true`).
- Stretchly deb at `/opt/Stretchly`, autostart at `~/.config/autostart/stretchly.desktop`,
  config at `~/.config/Stretchly/config.json`. (A stray snap install was purged 2026-08-27.)

### Why a Shell extension is the only option, not a preference

- **Q1 = Hard**: cover every monitor, refuse focus changes, no dismiss. Under Wayland
  only the compositor can do that; apps cannot grab input, be always-on-top, or span
  monitors. GNOME's compositor (Mutter) runs in-process with gnome-shell, and the only
  supported way to run code there is a Shell extension.
- X11 is not a fallback: no X11 session exists (above).
- Existing options were checked at source, none fit:
  - *Simple Break Reminder*, *Break Reminder* (e.g.o): `MessageTray.Notification` with
    a "wait a bit" button — notification-only.
  - *Stretch Break* (Rust/GTK4 + companion extension): break window is a normal GTK
    window with **Skip** and **Postpone** buttons, one break type; author closed
    "Enforce a break" (issue #10): *"If Wayland doesn't support it, there's no chance
    that Stretch Break will implement it."* Always-on-top (#5) still open. Companion
    extension is a panel countdown over D-Bus only; `metadata.json` lists shell 48–49.
  - GNOME 48+ built-in *Wellbeing → Break Reminders*: notifications only.
- Note: Stretchly's own "strict mode" on Wayland is weaker than it looks — an Electron
  fullscreen window with the skip button removed; `Super` / `Alt+Tab` leave it. hardbreak
  will be the first genuinely hard enforcer on this desktop.
- **Rust was wanted (language familiarity) and is ruled out**: Shell extensions are
  GJS only, no FFI path. A Rust daemon + thin GJS overlay (Stretch Break's shape) would
  leave the modal, watchdog, per-monitor actors, panel menu and postpone button — most
  of the real code — in JS, and add a daemon, a D-Bus interface, a user service and a
  "daemon died" failure mode to gain a 30-minute timer in Rust. Not worth it here.

## 2. Enforcement (Q1 Hard, Q2, Q3)

- A break is a **modal overlay** (`Main.pushModal`) with one full-monitor actor per
  monitor from `Main.layoutManager.monitors`, added as chrome above everything.
- **No dismiss, no end-early key** (no `Ctrl+X` equivalent).
- **Postpone** (Q2a): once per break, button visible/active only during the **first
  30 %** of the break; +2 min (mini) / +5 min (long). Both settings.
- **Watchdog** (Q3a): the modal is *always* released by an independent hard deadline —
  break duration + 30 s ⚠ (constant, not a setting) — scheduled separately from the
  countdown logic, and released on any caught exception in the break path. There is
  **no hidden escape chord**; recovery from a genuine hang is the watchdog, not the user.
- ⚠ Breaks auto-end when the countdown reaches zero; no "click to finish".
- Panel menu is irrelevant during a break (modal grabs input). Outside breaks it is fully
  functional (section 6). This matches Stretchly's default
  `showTrayMenuInStrictMode: false` behaviour, which Anton had assumed was self-inflicted.

*Addendum, 2026-08-27 (Q1 revisited for publication).* A `strict` setting, **default off**.
Soft mode (the default) keeps the modal wall exactly as above — every keybinding still
refused, input still grabbed — but the overlay carries a **Skip break** button (visible for
the whole break) and **Escape** ends the break early; a skipped break ends with the new
`'skipped'` reason, plays no sound, and counts as taken (counters advance, next interval
runs from the skip). Strict mode is the original Hard behaviour: no Skip, no Escape, only
the countdown and the watchdog. Anton runs strict. The watchdog, the modal and the
keybinding block are identical in both modes.

## 3. Schedule (Q5) — features with defaults; every value is a GSetting

| Setting | Default | Notes |
|---|---|---|
| `mini-interval` | 30 min | time between breaks |
| `mini-duration` | 60 s | |
| `long-duration` | 3 min | |
| `minis-per-long` | 1 ⚠ | Stretchly `breakInterval: 1` → alternating mini / long: 3‑min break on the hour, 1‑min on the half-hour |
| `mini-warning` | 10 s | Shell notification before the break |
| `long-warning` | 30 s | |
| `mini-postpone` | 2 min | |
| `long-postpone` | 5 min | |
| `postpone-window` | 30 % | fraction of the break during which postpone is offered |
| `idle-reset` | 5 min | "natural breaks": idle ≥ this → fresh cycle |
| `morning-hour` | 06:00 | "pause until tomorrow" target |

### State sources (facts) and rules (decisions)

- **Idle**: Shell core idle monitor (`global.backend.get_core_idle_monitor()` →
  `add_idle_watch` / `add_user_active_watch`); no polling, no D-Bus. Idle ≥
  `idle-reset` → the cycle restarts fresh when activity resumes.
- **Lock / suspend** (Q8b): `Main.screenShield` `locked-changed` plus `login1`
  `PrepareForSleep`. Same rule as idle: away ≥ `idle-reset` → fresh cycle, otherwise
  resume where it left off. (Stretchly resumes unconditionally — the "back from lunch,
  break due in 3 minutes" behaviour is explicitly unwanted.)
  - *Addendum, 2026-08-27 (implementation).* The above only works if the extension keeps
    running while the screen is locked, so `metadata.json` declares
    `"session-modes": ["user", "unlock-dialog"]`; without it GNOME calls `disable()` on
    every lock and `enable()` on every unlock, making each lock a fresh cycle and
    `locked-changed` unobservable. The panel button hides itself on the lock screen.
    Consequently: lock or suspend **interrupts** a running break (the overlay must never
    end up over the unlock dialog, and no break starts while locked); the interrupted
    break is *owed*, not skipped — a return sooner than `idle-reset` replays its warning
    and puts the same break back up, and a return after `idle-reset` or more counts as
    the break and starts a fresh cycle. Going idle, by contrast, never interrupts a
    break: being idle is exactly what the wall makes you.
  - *Review correction, 2026-09-09:* also observe `Main.sessionMode.updated` and
    `isLocked`: GNOME can enter `unlock-dialog` during screen blanking without
    setting `screenShield.locked`. Entering that mode interrupts a break and removes
    its keyboard handlers. No new break starts there; independent lock and session
    reasons must both clear before resuming.
- **DND** (Q9a): `org.gnome.desktop.notifications` `show-banners` = false → **full
  pause**, no breaks at all; when it comes back on, fresh cycle. This is the classroom
  guard: one Quick Settings toggle before teaching on a projector. Explicitly *not*
  doing screen-share / mirrored-display auto-pause (rejected as "clever that fires at
  the desk dock").
- **Calendar** (grilled 2026-09-25; [ADR 0001](adr/0001-calendar-driven-pauses.md),
  terms in `CONTEXT.md`). Timed events in **watched calendars** (ticked in preferences,
  stored as EDS source uids in `watched-calendars`) are **busy events**, and while one
  holds, breaks are in **calendar pause**. Recurrences and exceptions come from the
  calendar via Evolution Data Server; hardbreak has no rule editor. All-day events never
  count, and there is no per-event keyword escape. **Lead shadow**: no break may start
  whose warning + duration would not finish 60 s before a busy event begins (a constant).
  When a busy event ends, a fresh cycle starts. A busy event that becomes active during a
  break (a late calendar edit) interrupts it, and the break is not owed; this makes the
  calendar a deliberate bypass even in strict mode. Menu status: "Busy until HH:MM", or
  "Busy at HH:MM" during the lead shadow, never showing the event title. If EDS or its
  GI bindings are unavailable, the gate is inert and breaks continue. Busy events already
  fetched (a rolling 48-hour window) keep gating, warnings go to the journal only, and
  DND stays the manual backstop.
  - *Addendum, 2026-09-26 (sync latency, observed on this machine).* hardbreak reacts as
    soon as EDS's local copy changes, but EDS only pulls online calendars when a calendar
    is first opened (login), then every `[Refresh] IntervalMinutes` (30 for Microsoft 365).
    When the network returns it refreshes at most once an hour. hardbreak does not request
    syncs (Anton, 2026-09-26: leave it at that for now; the option was a sync at start, on
    return and every 5 min). So an edit made on another device takes up to ~30 min to take
    effect, and longer after a resume. The "late calendar edit" interrupt above is
    therefore **not** a quick remote off switch; DND is the immediate one.

## 4. Overlay

- Every monitor covered. Colour `#633738`, opacity 0.9 — both settings
  (`overlay-color`, `overlay-opacity`).
- Centred: countdown, plus one idea drawn at random from the mini or long list.
- Ideas live in a bundled, editable `assets/ideas.json` (not in dconf). Seed it from
  Stretchly's `microbreakIdeas` / `breakIdeas` — copy them from
  `~/.config/Stretchly/config.json` (they are the Stretchly defaults, BSD-2-Clause).
- Postpone button per section 2.

## 5. Sound (Q10a)

- Break **end**: play bundled `assets/crystal-glass.wav` (from
  `https://raw.githubusercontent.com/hovancik/stretchly/master/app/audio/crystal-glass.wav`,
  BSD-2-Clause — add attribution to `LICENSE`). Nothing at break start.
- Setting `end-sound`: file path; default = the bundled file; empty = silent. Anyone
  wanting the system chime sets `/usr/share/sounds/freedesktop/stereo/complete.oga`.
- Play via `global.display.get_sound_player().play_from_file(...)`.

## 6. Panel indicator (Q5 #10–11)

- Icon only — **no countdown label** (no per-second repaints, no nag).
- Menu, outside breaks: **Pause 1 h · Pause 2 h · Pause until tomorrow** (`morning-hour`)
  · **Reset** · **Disable** (toggle). No 30‑min pause (Reset covers it), no
  skip-to-next-mini/long items (pointless with a fixed alternation).

## 7. Settings UI (Q6a)

- GSettings schema `org.melser.hardbreak` (`schemas/org.melser.hardbreak.gschema.xml`,
  compiled with `glib-compile-schemas` into `dist/schemas/` on build for the local
  install).
- **Addendum 2026-08-27:** the schema id, path and filename became
  `org.gnome.shell.extensions.hardbreak` / `/org/gnome/shell/extensions/hardbreak/` /
  `schemas/org.gnome.shell.extensions.hardbreak.gschema.xml` — extensions.gnome.org
  requires that base (EGO-P-001, EGO-P-002). The pre-1.0.1 names above (and in §8's
  layout) stand as the record of what was agreed; nothing is migrated.
- `prefs.ts` → libadwaita preferences page: spin rows for the intervals/durations,
  colour + opacity, file chooser for `end-sound`, switches where relevant. The
  Extensions app's ⚙ button must work.

## 8. Tooling (Q7 TypeScript) and repo shape

- **TypeScript** (`typescript` 7, ESNext), `@girs/gnome-shell@50.x` (50.0.4 published),
  `@girs/gjs@4.x`. `src/*.ts` → `tsc` → `dist/` (ESM). `dist/` is what gets installed.
- **bun 1.4** is the hard preference for everything tooling-side (install, scripts,
  `tsc`, `bun test`), pinned via `mise.toml` (`bun = "1.4"`) and
  `"packageManager": "bun@1.4.0"`. The single exception is the runtime: the extension
  itself is executed by gnome-shell's SpiderMonkey/GJS, not bun, so there is no
  bundling (`gi://` / `resource:///` imports must be emitted verbatim) and the
  scheduler must stay GJS-free so bun can unit-test it.
- **bun** only; scripts in the standard check-default shape: `format` / `lint` (check),
  `format:write` / `lint:fix`, `typecheck`, `check`, `validate`, `build`, and
  `install` = symlink `dist/` → `~/.local/share/gnome-shell/extensions/hardbreak@melser.org` (⚠ amended 2026-08-27: `install:ext` *copies* `dist/` — a symlink let every rebuild mutate the live extension)
  (plus `uninstall`). **oxlint / oxfmt**, no eslint/prettier/biome.
- Git: `main` + `develop`, rebase-only, linear history. ⚠ MIT licence (as conform-ed),
  with the Stretchly BSD-2-Clause attribution for the wav and idea lists.
- Layout:
  ```
  src/extension.ts   src/prefs.ts   src/*.ts (scheduler, overlay, watchdog, indicator…)
  schemas/org.melser.hardbreak.gschema.xml
  assets/ideas.json  assets/crystal-glass.wav
  metadata.json  stylesheet.css  dist/ (gitignored)  docs/spec.md  CLAUDE.md
  ```
- `metadata.json`: `"shell-version": ["50"]`.

## 9. Testing

- **Never exercise the modal path on the live session first.** Use
  `dbus-run-session -- gnome-shell --devkit` (GNOME 49+ replacement for `--nested`): a
  second Shell in a window; a bug there locks a window, not the desktop.
- Logs: `journalctl -f -o cat /usr/bin/gnome-shell`.
- The watchdog and the exception path are the tests that matter most; scheduler logic
  (alternation, postpone window, idle/lock/DND resets) is plain TS and unit-testable
  with `bun test` without the Shell.

## 10. Distribution (Q11a)

Local only. Public GitHub repo, no extensions.gnome.org submission, no release zips.
Revisit e.g.o only if it is wanted on a second machine (tsc output is review-readable).

*Addendum, 2026-08-27 (decision reversed).* Publish on e.g.o and as GitHub release zips;
see the README. The soft/strict switch (Q1 revisit) is decided — see the §2 addendum.
Remaining decision for publication: supported Shell versions (48–50 wanted, only 50 tested).

*Addendum, 2026-09-25.* Shell 50 only (decided 2026-08-27). extensions.gnome.org declined
the submission because the extension is LLM-written, so distribution is GitHub release zips
only, with no resubmission.

## 11. Cut-over from Stretchly (Q12a)

Two enforcers at once = two walls on drifting schedules; overlap must be zero.

1. Day hardbreak is enabled on the live session:
   `rm ~/.config/autostart/stretchly.desktop && pkill -f /opt/Stretchly/stretchly`
   Leave the deb installed as rollback.
2. After a trial fortnight with no session lock-ups:
   `sudo apt purge stretchly && rm -rf ~/.config/Stretchly`

## 12. Out of scope

Rust; X11; extensions.gnome.org; screen-share / mirrored-display auto-pause;
skip-to-next-break menu items; app exclusions; panel countdown; any end-early key;
hidden escape chord; GNOME Wellbeing as a stopgap.
