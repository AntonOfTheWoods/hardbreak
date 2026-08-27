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

import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dist, extensionLink, fail, firstRun, root, writeProfile } from './devkit-common.js';

const link = lstatSync(extensionLink, { throwIfNoEntry: false });
if (link === undefined || !link.isSymbolicLink()) {
  fail(
    `devkit refused: ${extensionLink} is not a symlink to ${dist}.\n` +
      'Run `bun run install:ext` first.',
  );
}
const linkTarget = resolve(dirname(extensionLink), readlinkSync(extensionLink));
if (linkTarget !== dist) {
  fail(
    `devkit refused: ${extensionLink} points at ${linkTarget}, not at ${dist}.\n` +
      'Run `bun run install:ext` first.',
  );
}

if (!existsSync(join(dist, 'metadata.json'))) {
  fail(`devkit refused: ${join(dist, 'metadata.json')} is missing.\nRun \`bun run build\` first.`);
}

const profile = writeProfile();
const inner = join(root, 'scripts', 'devkit-inner.ts');

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
    env: { ...process.env, DCONF_PROFILE: profile },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

process.exit(session.exitCode);
