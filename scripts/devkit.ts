#!/usr/bin/env bun
/**
 * Launch a nested gnome-shell for testing, isolated from the live session.
 *
 * Isolation has two halves:
 *   - `dbus-run-session` gives the nested Shell its own session bus;
 *   - `DCONF_PROFILE` points dconf at `~/.config/dconf/hardbreak_devkit`, so
 *     `enabled-extensions` and every `org.gnome.shell.extensions.hardbreak` key written in
 *     there never touch the live desktop's settings.
 *
 * Seeding has to happen on the nested bus (that is where `gsettings` activates
 * `ca.desrt.dconf`), so it lives in `devkit-inner.ts`, which this script runs
 * under `dbus-run-session` before the Shell starts.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail, firstRun, root, writeProfile } from './devkit-common.js';
import { dist, installDist, target } from './install-common.js';

// The devkit must run the tree that is on disk *now*, so the preflight is the
// install itself. That writes to the same directory as the live install — which
// is safe: the running Shell holds the code it loaded at enable() time, and the
// swap is a rename, never a half-written tree.
const outcome = installDist();
if (!outcome.ok) fail(`devkit refused: ${outcome.error}`);
console.log(
  `devkit: installed ${dist} to ${target} (the live session keeps running the code it loaded; log out/in to switch)`,
);

const profile = writeProfile();
const inner = join(root, 'scripts', 'devkit-inner.ts');

// `gnome-shell --devkit` runs headless on a virtual monitor and asks Mutter to
// launch a separate viewer window, /usr/libexec/mutter-devkit. Without it the
// Shell still starts — invisibly. On Ubuntu the viewer ships in mutter-dev-bin.
const viewer = '/usr/libexec/mutter-devkit';
if (!existsSync(viewer)) {
  fail(
    `devkit: ${viewer} is missing, so the nested Shell would run with no window. Install it: sudo apt install mutter-dev-bin`,
  );
}

// The devkit window is a client of the *live* compositor. A shell whose
// environment predates the current login (a tmux server, say) has no
// WAYLAND_DISPLAY, and the nested Shell then falls back to X11 with a stale
// XAUTHORITY, fails, and runs headless on a virtual monitor nobody can see.
const runtimeDir = process.env['XDG_RUNTIME_DIR'] ?? `/run/user/${process.getuid?.() ?? ''}`;
const waylandEnv: Record<string, string> = {};
if (!process.env['WAYLAND_DISPLAY']) {
  const socket = 'wayland-0';
  if (existsSync(join(runtimeDir, socket))) {
    waylandEnv['WAYLAND_DISPLAY'] = socket;
    console.log(`devkit: WAYLAND_DISPLAY was unset; using ${socket} from ${runtimeDir}`);
  } else {
    fail(
      `devkit: WAYLAND_DISPLAY is unset and ${join(runtimeDir, socket)} does not exist — run this from a terminal inside the graphical session.`,
    );
  }
}

const session = Bun.spawnSync(
  [
    'dbus-run-session',
    '--',
    process.execPath,
    'run',
    inner,
    ...(firstRun() ? ['--first-run'] : []),
  ],
  {
    cwd: root,
    env: { ...process.env, ...waylandEnv, DCONF_PROFILE: profile },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

process.exit(session.exitCode);
