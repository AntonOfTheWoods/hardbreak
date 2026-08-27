#!/usr/bin/env bun
/**
 * Runs *inside* the fresh `dbus-run-session` bus, before gnome-shell starts.
 *
 * Everything here writes to the isolated dconf database named by
 * `DCONF_PROFILE` (set by `devkit.ts`), so it is invisible to the live session.
 * Set `HARDBREAK_DEVKIT_DRY_RUN=1` to seed and print instead of launching the
 * Shell — that is how the seeding is testable without a display.
 */

import {
  dbForProfile,
  FAST_SCHEDULE,
  fail,
  gsettingsEnv,
  hasKey,
  root,
  runOrFail,
  SCHEMA,
  schemaDir,
  UUID,
} from './devkit-common.js';

const profile = process.env['DCONF_PROFILE'];
if (profile === undefined || profile === '') {
  fail('devkit-inner: DCONF_PROFILE is not set — run this through `bun run devkit`.');
}
if (process.env['DBUS_SESSION_BUS_ADDRESS'] === undefined) {
  fail('devkit-inner: no DBUS_SESSION_BUS_ADDRESS — run this through `bun run devkit`.');
}

const first = process.argv.includes('--first-run');
const dryRun = process.env['HARDBREAK_DEVKIT_DRY_RUN'] === '1';
const env = gsettingsEnv();
const db = dbForProfile(profile);

function set(schema: string, key: string, value: string): void {
  runOrFail(['gsettings', 'set', schema, key, value], env);
}

/** Set a key only if the schema is installed; the devkit must run without it. */
function setIfPresent(schema: string, key: string, value: string): boolean {
  if (!hasKey(schema, key, env)) return false;
  set(schema, key, value);
  return true;
}

// 1. Every launch: hardbreak is the only extension, and user extensions are on.
set('org.gnome.shell', 'enabled-extensions', `['${UUID}']`);
set('org.gnome.shell', 'disable-user-extensions', 'false');

// 2. Every launch: keep Tracker from D-Bus-activating on the fresh bus and
//    re-crawling the whole home directory. `crawling-interval` -2 disables
//    crawling outright (the schema's range is -2..365).
const TRACKER = 'org.freedesktop.Tracker3.Miner.Files';
let tracker = false;
for (const [key, value] of [
  ['index-recursive-directories', '[]'],
  ['index-single-directories', '[]'],
  ['enable-monitors', 'false'],
  ['crawling-interval', '-2'],
] as const) {
  tracker = setIfPresent(TRACKER, key, value) || tracker;
}
setIfPresent('org.gnome.desktop.search-providers', 'disable-external', 'true');

// 3. First run only: a schedule short enough to exercise a whole cycle. Later
//    launches must not clobber whatever the user has since changed.
if (first) for (const [key, value] of FAST_SCHEDULE) set(SCHEMA, key, value);

console.log('');
console.log('hardbreak devkit');
console.log(`  dconf db      ${db.path}  (isolated; live settings untouched)`);
console.log(`  profile       ${profile}`);
console.log(`  schemas       ${schemaDir}`);
console.log(`  extension     ${UUID} (enabled in ${db.name})`);
console.log(
  `  fast schedule ${first ? 'seeded (mini every 1 min)' : 'not reseeded — using the db as-is'}`,
);
console.log(`  indexing      ${tracker ? 'Tracker crawling disabled' : 'Tracker not installed'}`);
console.log('');
console.log('  settings/extension commands:  bun run devkit:ctl <get|set|enable|disable|info|…>');
console.log('  back to a first run:          bun run devkit:reset');
console.log('  the Shell logs to THIS terminal (`bun run logs` follows the live session)');
console.log('');

if (dryRun) {
  console.log('HARDBREAK_DEVKIT_DRY_RUN=1 — not launching gnome-shell --devkit');
  process.exit(0);
}

const shell = Bun.spawnSync(['gnome-shell', '--devkit'], {
  cwd: root,
  env: process.env as Record<string, string>,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

process.exit(shell.exitCode);
