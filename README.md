# hardbreak

A GNOME Shell extension that makes you take screen breaks. At the appointed time it covers
every monitor with an overlay that owns the input grab: you cannot alt-tab away from it,
cannot put anything in front of it and cannot close it — it goes away when the break is
over. By default it offers a Skip button and Escape; turn on **strict mode** and it does
not, and the countdown is the only way out. Because it runs inside gnome-shell itself it
adds no processes, no tray app and no background service: the whole thing is the Shell's
own timers and actors.

It exists because [Stretchly](https://github.com/hovancik/stretchly) — the obvious choice
otherwise — is an Electron app (five Chromium processes, ~287 MB) whose "strict mode" is
still just a fullscreen window on Wayland: `Super` and `Alt+Tab` walk straight out of it.
Under Wayland only the compositor can genuinely hold the screen, and on GNOME the only way
to run code in the compositor is an extension.

GNOME Shell 50, Wayland. Tested on Ubuntu 26.04.

## Before you install

**A break is a wall, in both modes.** When one starts, every monitor is covered by an
overlay that owns the input grab: every keybinding is refused, nothing else can be focused,
raised or closed, and the panel is unreachable until the break is over.

The one thing that differs is whether you can end a break early:

- **Soft mode — the default.** The overlay carries a **Skip break** button for the whole
  break, and **Escape** does the same thing. A skipped break counts as taken: the
  alternation moves on and the next interval starts from the skip.
- **Strict mode** (`strict`, off by default; the switch is the first thing in the settings).
  No Skip button, no Escape, no dismiss, no secret chord. The countdown ends the break and
  nothing else does. **This is hard mode, and it is the entire point of the extension** —
  everything below about a wedged session applies to it.

What you get in both modes:

- the **panel menu** (the alarm icon in the top bar): Pause 1 hour, Pause 2 hours, Pause
  until tomorrow, Reset, and a **Breaks** switch that turns the whole thing off. It is
  reachable between breaks — during a break the overlay has the input grab, so nothing in
  the panel is clickable;
- **Do Not Disturb**: turning it on in Quick Settings pauses hardbreak completely. This is
  the one-toggle guard before you present on a projector;
- a **postpone** button on the overlay itself, once per break, and only during the first
  30 % of it (+2 minutes for a mini break, +5 for a long one; all three configurable);
- the **watchdog**: an independent deadline that takes the overlay down 30 seconds after
  the break should have ended, and takes it down immediately if anything in the break code
  throws. It is the safety net, and it is deliberately not user-configurable.

If that sounds like more than you want, GNOME 48+ has _Settings → Wellbeing → Break
Reminders_, which sends notifications you can ignore.

## If your screen stays locked

Mostly a strict-mode concern — in soft mode Escape ends the break — but the way out is the
same either way. Ctrl+Alt+F3 still works while the overlay is up: switching virtual
terminals is handled below the level anything on screen can block. From the text console:

```sh
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus \
  gnome-extensions disable hardbreak@melser.org
```

Then switch back to your graphical session (usually Ctrl+Alt+F2, sometimes Ctrl+Alt+F1).
The overlay is gone and breaks are off until you enable the extension again. The
`DBUS_SESSION_BUS_ADDRESS` part matters: without it `gnome-extensions` on a TTY has no
session bus to talk to and will do nothing.

If that ever happens, please [open a bug](.github/ISSUE_TEMPLATE/bug_report.md) — the
watchdog should have released the screen without you.

Related, and normal: **locking the screen or closing the lid interrupts a running break.**
The overlay must never end up on top of the unlock dialog. The break is owed, not
forgiven — come back sooner than the "natural break threshold" (5 minutes by default) and
you get its warning and then the same break again; stay away longer than that and the time
away counts as the break, so the cycle starts fresh.

## How it works

### The schedule

|                                 | default                 |                                  |
| ------------------------------- | ----------------------- | -------------------------------- |
| interval between breaks         | 30 min                  |                                  |
| mini break                      | 60 s                    | on the half hour                 |
| long break                      | 3 min                   | on the hour                      |
| mini breaks between long breaks | 1                       | so they alternate                |
| warning before a mini break     | 10 s                    | a notification                   |
| warning before a long break     | 30 s                    |                                  |
| postpone                        | +2 min / +5 min         | mini / long, once per break      |
| postpone window                 | first 30 % of the break | after that the button is gone    |
| natural break threshold         | 5 min                   | time away that counts as a break |

### The overlay

One full-screen actor per monitor (`#633738` at 90 % opacity by default), showing the
countdown, a suggestion of what to do with the minute — the idea lists live in
`assets/ideas.json` and can be edited — and the postpone button while it applies. Every
keybinding is refused while it is up, including the overview key. In soft mode (the
default) there is also a **Skip break** button, which stays for the whole break, and
**Escape** presses it; strict mode has neither. It ends by itself; a sound plays when it
does — and only then, never for a skipped, postponed or interrupted break.

### What pauses it

- **Idle.** If you are away from the keyboard for the natural break threshold, the Shell's
  idle monitor says so and the cycle restarts when you come back: a real break counts.
  Going idle never interrupts a _running_ break — sitting still is exactly what the
  overlay is asking for.
- **Lock and suspend.** Same threshold, but these interrupt a running break, as described
  above.
- **Do Not Disturb.** `show-banners` off means no breaks at all, and a fresh cycle when it
  comes back on.
- **The panel menu.** Pause 1 h, 2 h, or until tomorrow morning (06:00 by default); Reset
  starts the current interval again; the Breaks switch stops everything until you flip it
  back, and survives a reboot.

Every deadline is measured on the monotonic clock, so a suspended laptop does not wake up
owing you six breaks.

### Why it keeps running on the lock screen

`metadata.json` declares `"session-modes": ["user", "unlock-dialog"]`. Without it GNOME
disables every extension when the screen locks and enables it again on unlock, which would
make each lock a fresh cycle and would hide the lock and suspend events the schedule is
built on. The consequences are the ones you want: the panel icon hides itself on the lock
screen, and **no break can start while the session is locked**.

## Settings

Through _Extensions → hardbreak → ⚙_, or with `gsettings`/`dconf` under
`org.gnome.shell.extensions.hardbreak`.

Version 1.0.0 used the schema id `org.melser.hardbreak`; settings made under it are not
migrated, so an upgrade from 1.0.0 starts again from the defaults below.

| key               | unit                                                | default             |
| ----------------- | --------------------------------------------------- | ------------------- |
| `mini-interval`   | minutes (1–240)                                     | 30                  |
| `mini-duration`   | seconds (5–3600)                                    | 60                  |
| `long-duration`   | seconds (5–3600)                                    | 180                 |
| `minis-per-long`  | count (0–20); 0 = every break is long               | 1                   |
| `mini-warning`    | seconds (0–300); 0 = no warning                     | 10                  |
| `long-warning`    | seconds (0–300); 0 = no warning                     | 30                  |
| `mini-postpone`   | minutes (0–60); 0 = no postponing minis             | 2                   |
| `long-postpone`   | minutes (0–60); 0 = no postponing longs             | 5                   |
| `postpone-window` | percent of the break (0–100); 0 = no postponing     | 30                  |
| `idle-reset`      | minutes away that count as a break (1–120)          | 5                   |
| `morning-hour`    | hour, local time (0–23), for "pause until tomorrow" | 6                   |
| `overlay-color`   | CSS hex                                             | `#633738`           |
| `overlay-opacity` | 0–1                                                 | 0.9                 |
| `end-sound`       | file path, or empty for silence                     | `crystal-glass.wav` |
| `strict`          | on/off; no Skip button and no Escape during a break | false               |
| `breaks-enabled`  | on/off; the panel switch                            | true                |
| `first-run-done`  | on/off; set false to see the first-run notice again | false               |

`strict` is read when a break starts, so switching it applies from the next break, not the
one already on screen. With it off — the default — the overlay offers Skip and Escape; with
it on, the countdown is the only way out (see _Before you install_).

`end-sound` is played when a break **ends**, never when one starts. A bare filename is
looked up in the extension's own `assets/` directory (that is how the default works); an
absolute path is used as given — `/usr/share/sounds/freedesktop/stereo/complete.oga` for
the system chime — and an empty string means silence.

## Install

**From extensions.gnome.org** — pending review; this section will carry the link once it
is published.

**From a release zip** ([Releases](https://github.com/AntonOfTheWoods/hardbreak/releases)):

```sh
gnome-extensions install hardbreak@melser.org.shell-extension.zip
```

Then log out and back in (on Wayland a new extension is only picked up by a fresh session)
and enable it:

```sh
gnome-extensions enable hardbreak@melser.org
```

**From source** — needs [bun](https://bun.sh) 1.4 and `glib-compile-schemas`:

```sh
bun install            # also installs the pre-commit hook
bun run build          # tsc -> dist/, plus assets, schema and glib-compile-schemas
bun run install:ext    # copy dist/ into ~/.local/share/gnome-shell/extensions/
```

Log out and back in, then `gnome-extensions enable hardbreak@melser.org`. The install is a
**copy**, so rebuilding changes nothing that is installed: run `bun run install:ext` again
(and log out and back in) to move the running session onto new code. `bun run uninstall:ext`
removes the installed directory.

The first time it is enabled, hardbreak posts a notification saying what it is about to do
and — in strict mode — how to get out of it. That is the `first-run-done` setting above.

## Reporting bugs

[Open an issue](https://github.com/AntonOfTheWoods/hardbreak/issues/new?template=bug_report.md);
the [template](.github/ISSUE_TEMPLATE/bug_report.md) asks for the things that matter: Shell
version, distribution, Wayland or X11, whether the watchdog released the screen, and

```sh
journalctl -b -o cat /usr/bin/gnome-shell | grep -i hardbreak
```

## Development

```sh
bun run validate       # format + typecheck + lint + test (this is the pre-commit hook)
bun run test           # the scheduler and watchdog are GJS-free and unit-tested
bun run build          # dist/
bun run pack           # tmp/pack/hardbreak@melser.org.shell-extension.zip, verified
bun run devkit         # nested gnome-shell, isolated bus + isolated dconf db
bun run devkit:ctl     # drive the running devkit (enable/disable/get/set/...)
bun run logs           # journalctl -f -o cat /usr/bin/gnome-shell (the LIVE session)
```

`bun run pack` rebuilds, stamps `version-name` into `dist/metadata.json` from the git tag
(`git describe`, leading `v` stripped — the checked-in `metadata.json` keeps `version: 1`,
which extensions.gnome.org assigns itself), and then checks the zip it produced: every
runtime file must be in it, and nothing test-only may be. CI runs `validate` + `pack` on every push and pull
request and uploads the zip; a `v*` tag additionally publishes a GitHub release with the
zip attached and the tag message as the notes (`.github/workflows/`).

**Never exercise the overlay on the live session first** — use `bun run devkit`, where a
bug locks a window rather than the desktop.

```sh
bun run build                          # dist/
bun run devkit                         # nested gnome-shell, isolated from the live session
```

`bun run devkit` installs `dist/` itself (the same copy `install:ext` does) so the nested
Shell always runs the tree you just built. That writes to the same directory as your live
install, which is safe — the running Shell keeps the code it loaded at enable() time — but it
does mean the next login picks up whatever the devkit last installed.

The devkit runs the nested Shell under `dbus-run-session` _and_ under its own dconf
database (`~/.config/dconf/hardbreak_devkit`, selected with `DCONF_PROFILE`), so:

- **the live session is untouched** — `enabled-extensions` and every `org.gnome.shell.extensions.hardbreak`
  key written in the devkit stay in the isolated database;
- **hardbreak is already enabled** there, with user extensions on and nothing else loaded;
- **the first run seeds a fast schedule** (`mini-interval 1`, `mini-duration 20`,
  `long-duration 30`, `mini-warning 5`, `long-warning 10`, both postpones 1) so a whole
  cycle is testable in minutes. Later runs leave your settings alone;
- **nothing re-indexes your home directory** — Tracker's file miner is disabled in that
  database, so the fresh bus does not activate it.

Drive the running devkit from your normal terminal with `devkit:ctl`, which finds the
nested Shell's bus address and talks to _it_ rather than to the live Shell:

```sh
bun run devkit:ctl disable                 # disable() mid-break — the watchdog test
bun run devkit:ctl enable                  # and back on
bun run devkit:ctl info                    # gnome-extensions info
bun run devkit:ctl set mini-interval 1     # org.gnome.shell.extensions.hardbreak keys, in the devkit db
bun run devkit:ctl get mini-interval
bun run devkit:ctl fast                    # re-apply the fast schedule
bun run devkit:ctl defaults                # reset every hardbreak key
bun run devkit:ctl eval 'Main.modalCount'  # JS inside the nested Shell; needs HARDBREAK_DEVKIT_UNSAFE=1 bun run devkit
bun run devkit:reset                       # delete the devkit db (next launch = first run)
```

`eval` runs arbitrary JS inside the nested Shell, so it is refused unless the devkit was
started with `HARDBREAK_DEVKIT_UNSAFE=1`. `devkit:reset` refuses while a devkit is running,
and only ever removes `~/.config/dconf/hardbreak_devkit`.

Two more things worth knowing:

- **Logs are split.** The devkit prints its own `console.*` / `logError` output to the
  stdout of the terminal that ran `bun run devkit`. `bun run logs` follows the _live_
  session's gnome-shell instead.
- The live Shell only sees a newly installed extension after a logout/login — it scans the
  extensions directory at startup. That is why `gnome-extensions enable hardbreak@melser.org`
  typed in an ordinary terminal reports that the extension "doesn't exist"; use
  `bun run devkit:ctl enable` for the devkit.

## Documentation

- [`docs/spec.md`](docs/spec.md) — the agreed specification; it wins on any conflict.
- [`docs/architecture.md`](docs/architecture.md) — module boundaries, settings keys, the
  scheduler state machine and the watchdog contract.

## Licence

MIT. `assets/crystal-glass.wav` and the idea lists in `assets/ideas.json` come from
Stretchly (BSD-2-Clause) — see [`LICENSE`](LICENSE).
