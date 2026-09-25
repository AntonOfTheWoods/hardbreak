# hardbreak

GNOME Shell extension (`hardbreak@melser.org`) that enforces screen breaks with an
undismissable full-screen overlay — a zero-process replacement for Stretchly.

**Read `docs/spec.md` first.** It is the agreed specification (decisions Q1–Q12, defaults,
state sources, tooling, cut-over plan) and it overrides anything inferred from Stretchly.

## Language and tooling

The machine-wide rules (bun, TypeScript 7, oxlint/oxfmt, check-default script names,
rebase-only git) all apply. Restated here only where this project is specific:

- **Language: TypeScript. Not Rust.** Rust was the first preference and was ruled out
  (spec §1): Shell extensions run only as GJS inside gnome-shell; there is no Rust path
  in, and a Rust daemon + JS overlay would leave all the hard parts in JS. Do not reopen
  this.
- **bun 1.4 for everything bun can do** — pinned in `mise.toml` and
  `"packageManager": "bun@1.4.2"`. Install, scripts, running `tsc`, unit tests
  (`bun test`), `glib-compile-schemas` wrapper scripts. Never npm/npx/yarn/pnpm.
- **The one thing bun cannot do is run the extension.** The runtime is gnome-shell's own
  JS engine (SpiderMonkey via GJS 1.88), loading `dist/extension.js` / `dist/prefs.js` as
  ESM with `gi://` and `resource:///` imports. Consequences:
  - Build is `tsc` emit → `dist/` (ESNext, ESM, no bundling — `gi://`/`resource:///`
    imports must survive verbatim). Don't reach for `bun build`.
  - Types come from `@girs/gnome-shell@50` and `@girs/gjs`; keep them matched to the
    installed Shell (50.1).
  - Keep the scheduler / state-machine code **free of GJS imports** so `bun test` can
    exercise it; only the thin Shell-facing modules touch `gi://` / `resource:///`.
- **oxlint / oxfmt** via `bun run lint` / `bun run format` (check) and `lint:fix` /
  `format:write` (mutate). No eslint, prettier, or biome config files.

## Safety

- Enforcement in **strict mode** is Hard: no dismiss, no escape chord. Soft mode (the
  default) adds a Skip button and Escape, nothing else — the modal, the keybinding block
  and the **watchdog** are identical in both modes; treat the watchdog as the most
  important code in the repo.
- Never test the modal/overlay path on the live session first: use
  `dbus-run-session -- gnome-shell --devkit`.

## Provenance

- Bundled `assets/crystal-glass.wav` and `assets/ideas.json` come from Stretchly
  (BSD-2-Clause) — keep the attribution in `LICENSE`.
