# Extension review notes

Reviewed against the [GNOME review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
and [TypeScript guide](https://gjs.guide/extensions/development/typescript.html) on 2026-09-09.
This records the current implementation and checks; it is not an EGO approval.

## Runtime and submission

- Initialization creates only static JavaScript state. Settings, actors, signals and
  timeouts are created from `enable()`; `disable()` tears down each owner.
- Presence tracks idle, suspend, password locking and session-mode blanking separately.
  Entering `unlock-dialog` destroys the overlay and its keyboard handlers. Scheduling
  resumes only after all absence reasons clear. The reason for retaining this session
  mode is documented directly in `disable()`.
- Warning and first-run notifications are owned and destroyed. Their shared system
  notification source belongs to Shell and is not destroyed by the extension.
- End-of-break audio has a cancellable owned by the controller. Disable and replacement
  playback cancel it. The idea-book read also has a cancellable and ignores late results
  after disable.
- Runtime imports separate Shell UI from Gtk/Gdk/Adw preferences. The extension does not
  spawn subprocesses, access the clipboard, collect telemetry, change other extensions,
  or call `run_dispose()`.
- Metadata describes soft mode and optional strict enforcement accurately, lists only
  Shell 50, and omits the numeric `version` assigned by EGO. Packaging derives
  `version-name` from git, using only letters, digits, spaces and dots within 16 characters,
  following the [metadata format](https://gjs.guide/extensions/overview/anatomy.html#version-name).
  The schema ID, path and XML filename use GNOME's extension base.
- The ZIP includes readable JavaScript, required assets, schema XML and the licence
  notices for the MIT code and BSD Stretchly assets. Build scripts, dependencies, tests,
  TypeScript sources and source maps are excluded. Audio data is not an executable.

## TypeScript and editor support

The project uses the guide's four ambient imports from `@girs/gjs` and
`@girs/gnome-shell`, an ESM package, default-exported extension/preferences classes and
`tsc` emission into `dist/`. `NodeNext` resolution enforces explicit relative ESM paths;
all runtime relative imports use `.js`. Failed compilation cannot emit new JavaScript.
The root solution configuration makes the runtime, tooling and Shell-test projects
discoverable to editors while the runtime check excludes Bun globals.

Bun scripts implement the tutorial's build/package/install steps. The tutorial's npm,
Makefile, ESLint recommendation and ES2023 example are not submission requirements: this
repo retains Bun, oxlint/oxfmt and its GNOME 50 ESNext target. Type declarations and build
dependencies are development tools and are not loaded by GJS.

## Verification and remaining scope

`bun run validate` checks formatting, all three TypeScript projects, lint and unit tests.
Shell adapter tests exercise real scheduling/controller/overlay code with mocked GI and
Shell services, including overlapping lock signals and notification/audio cleanup.
`bun run pack` rebuilds and checks required and forbidden archive entries.

An isolated GNOME Shell 50.1 session with one virtual monitor verified overlay/modal
release on entering `unlock-dialog`, first-run notification destruction and re-enabling.
These checks do not claim coverage of every physical monitor, audio device or distribution.
Shell 51 support and translations remain separate work. The maintainer still needs to
understand, review and maintain submitted code, as required by the review guidelines.

## Independent checker evaluation

Tested the standalone `ego-lint` from
[gnome-extension-reviewer](https://github.com/ZviBaratz/gnome-extension-reviewer)
0.1.31, commit `158f59d364a0568efd1b38b5339539633b0649d0`. The input was the extracted
submission ZIP in a directory matching its UUID, rather than the TypeScript source tree or
the local-install `dist/` tree containing compiled schemas. All checker scratch files stayed
under `tmp/agents/ego-review/`; the Claude plugin was not installed or invoked.

The first run reported 213 passes, 3 failures, 20 warnings and 12 skips. One failure was
real: our old git-description sanitizer preserved hyphens in `version-name`. The sanitizer
and package assertion now follow the official format, with regression tests. Another failure
matched a comment listing forbidden imports in `prefs.js`; that comment was shortened to a
plain process-isolation note. The third failure cannot follow Presence's session-mode
callback through the controller into `Overlay.hide()` and actor destruction. The adapter
tests and isolated Shell test cover that exact cleanup path.

The rerun reports **215 passes, 1 failure, 20 warnings and 12 skips**, exiting 1 because
the lock-screen finding remains. This is not a clean checker pass. Its
[same-file guard heuristic](https://github.com/ZviBaratz/gnome-extension-reviewer/blob/158f59d364a0568efd1b38b5339539633b0649d0/skills/ego-lint/scripts/check-lifecycle.py#L677)
cannot establish the absence of cross-module cleanup. The raw before/after reports are
`tmp/agents/ego-review/ego-lint-before.txt` and `tmp/agents/ego-review/ego-lint.txt`.

The 20 warnings comprise 15 resource reports plus their ownership summary (the checker does
not recognize `hide()` as cleanup), a local logger mistaken for GJS's legacy global `log`,
the logger's valid `unknown`-to-`Error` narrowing, a suggestion to use `connectObject`, and a
generic file-I/O disclosure suggestion. Here file access reads bundled ideas and the chosen
sound; it does not transmit user files. These are advisory findings, not reasons to invent
new lifecycle flags or change correct ownership.

Use this tool as an optional submission check and classify its findings against current
GNOME guidance. Do not make its unfiltered exit code a required CI gate yet: its lock-screen
test searches for guard-related words in the same file, and its resource parser recognizes
only certain cleanup method names. Some rule suggestions also recommend `_destroyed` flags,
which conflict with the current best-practices page. The checked-in validation, packaging
checks and lifecycle tests remain the required gates.

Final project validation passed: **135 tests**, typechecking, lint, formatting and ZIP
packaging. A TypeScript 7 language-server probe resolved Gio, Adw and the Shell test
imports through the solution configuration. The isolated Shell 50.1 smoke test passed
again with the updated metadata and compiler configuration.
