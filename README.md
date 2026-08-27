# hardbreak

A GNOME Shell extension (`hardbreak@melser.org`) that enforces screen breaks with an
undismissable full-screen overlay on every monitor — a zero-process replacement for
[Stretchly](https://github.com/hovancik/stretchly).

Breaks are **hard**: no skip, no dismiss, no escape chord. A mini break every half hour, a
long one on the hour (both configurable), with a warning notification beforehand and a
postpone button that only works during the first third of the break. The only way out is
the watchdog, which releases the overlay on an independent deadline or on any exception.

Targets GNOME Shell 50 on Wayland. Local install only; not published to
extensions.gnome.org.

## Build and install

```sh
bun install            # also installs the pre-commit hook
bun run build          # tsc -> dist/, plus assets, schema and glib-compile-schemas
bun run install:ext    # symlink dist/ into ~/.local/share/gnome-shell/extensions/
gnome-extensions enable hardbreak@melser.org
```

On Wayland a newly added extension is only picked up by a fresh session: log out and back
in before enabling it for the first time. After that, `bun run build` alone is enough —
the symlink means the Shell reloads the new code the next time the extension is toggled.

`bun run uninstall:ext` removes the symlink.

## Development

```sh
bun run validate       # format + typecheck + lint + test (this is the pre-commit hook)
bun run test           # bun test — the scheduler and watchdog are GJS-free and unit-tested
bun run devkit         # nested gnome-shell, isolated bus + isolated dconf db
bun run devkit:ctl     # drive the running devkit (enable/disable/get/set/...)
bun run logs           # journalctl -f -o cat /usr/bin/gnome-shell (the LIVE session)
```

**Never exercise the overlay on the live session first** — use `bun run devkit`, where a
bug locks a window rather than the desktop.

## Testing in the devkit

```sh
bun run build && bun run install:ext   # once: dist/ -> ~/.local/share/gnome-shell/extensions/
bun run devkit                         # nested gnome-shell, isolated from the live session
```

`bun run devkit` runs the nested Shell under `dbus-run-session` _and_ under its own dconf
database (`~/.config/dconf/hardbreak_devkit`, selected with `DCONF_PROFILE`), so:

- **the live session is untouched** — `enabled-extensions` and every `org.melser.hardbreak`
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
bun run devkit:ctl set mini-interval 1     # org.melser.hardbreak keys, in the devkit db
bun run devkit:ctl get mini-interval
bun run devkit:ctl fast                    # re-apply the fast schedule
bun run devkit:ctl defaults                # reset every hardbreak key
bun run devkit:reset                       # delete the devkit db (next launch = first run)
```

`bun run devkit:ctl disable` while a wall is up is the standard mid-break teardown test.
`devkit:reset` refuses while a devkit is running, and only ever removes
`~/.config/dconf/hardbreak_devkit`.

Two more things worth knowing:

- **Logs are split.** The devkit prints its own `console.*` / `logError` output to the
  stdout of the terminal that ran `bun run devkit`. `bun run logs` follows the _live_
  session's gnome-shell instead.
- The live Shell only sees a newly installed extension after a logout/login — it scans the
  extensions directory at startup. That is why `gnome-extensions enable hardbreak@melser.org`
  typed in an ordinary terminal reports that the extension "doesn't exist"; use
  `bun run devkit:ctl enable` for the devkit.

## Going live

Once the devkit checks pass (watchdog release, exception release, disable mid-break,
Super/Alt+Tab blocked, postpone window):

1. Log out and back in — the live Shell only scans the extensions directory at startup.
2. Enable hardbreak in the Extensions app (or `gnome-extensions enable hardbreak@melser.org`).

Stretchly and its apt repository were removed on 2026-08-27, so there is no overlap to
manage and no rollback to keep.

## Documentation

- [`docs/spec.md`](docs/spec.md) — the agreed specification; it wins on any conflict.
- [`docs/architecture.md`](docs/architecture.md) — module boundaries, settings keys, the
  scheduler state machine and the watchdog contract.

## Licence

MIT. `assets/crystal-glass.wav` and the idea lists in `assets/ideas.json` come from
Stretchly (BSD-2-Clause) — see [`LICENSE`](LICENSE).
