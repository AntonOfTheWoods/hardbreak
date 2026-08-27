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
bun run devkit         # dbus-run-session -- gnome-shell --devkit
bun run logs           # journalctl -f -o cat /usr/bin/gnome-shell
```

**Never exercise the overlay on the live session first** — use `bun run devkit`, where a
bug locks a window rather than the desktop.

## Cutting over from Stretchly

1. The day hardbreak is enabled on the live session, stop Stretchly so the two enforcers
   never overlap:
   ```sh
   rm ~/.config/autostart/stretchly.desktop && pkill -f /opt/Stretchly/stretchly
   ```
   Leave the deb installed as a rollback.
2. After a trial fortnight with no session lock-ups:
   ```sh
   sudo apt purge stretchly && rm -rf ~/.config/Stretchly
   ```

## Documentation

- [`docs/spec.md`](docs/spec.md) — the agreed specification; it wins on any conflict.
- [`docs/architecture.md`](docs/architecture.md) — module boundaries, settings keys, the
  scheduler state machine and the watchdog contract.

## Licence

MIT. `assets/crystal-glass.wav` and the idea lists in `assets/ideas.json` come from
Stretchly (BSD-2-Clause) — see [`LICENSE`](LICENSE).
