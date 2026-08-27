#!/usr/bin/env bun
/**
 * Drive a running devkit from a normal terminal.
 *
 * Without this, `gnome-extensions enable hardbreak@melser.org` typed in an
 * ordinary shell talks to the *live* Shell (which reports "doesn't exist",
 * because it only scans the extensions directory at startup). Here the nested
 * Shell's bus address is read out of its `/proc/<pid>/environ`, so every
 * command lands on the devkit and in the devkit's dconf database.
 */

import {
  devkitBusAddress,
  FAST_SCHEDULE,
  fail,
  findDevkitPid,
  gsettingsEnv,
  run,
  SCHEMA,
  UUID,
  writeProfile,
} from './devkit-common.js';

const USAGE = `usage: bun run devkit:ctl <command>

  enable | disable      gnome-extensions enable|disable ${UUID}
  info                  gnome-extensions info ${UUID}
  prefs                 gnome-extensions prefs ${UUID}
  get <key>             gsettings get ${SCHEMA} <key>
  set <key> <value>     gsettings set ${SCHEMA} <key> <value>
  gsettings <args...>   raw gsettings passthrough (devkit bus + devkit db)
  fast                  re-apply the fast test schedule
  defaults              gsettings reset-recursively ${SCHEMA}
  eval <js>             run JS inside the nested Shell (needs HARDBREAK_DEVKIT_UNSAFE=1
                        at launch); \`Main\` is in scope, the result is printed as JSON

All of these act on the running devkit only; the live session is untouched.`;

const [command, ...rest] = process.argv.slice(2);
if (command === undefined || command === '--help' || command === '-h') {
  console.log(USAGE);
  process.exit(command === undefined ? 1 : 0);
}

const pid = findDevkitPid();
if (pid === undefined) fail('devkit:ctl: no devkit running — start one with `bun run devkit`.');
const bus = devkitBusAddress(pid);
if (bus === undefined) {
  fail(`devkit:ctl: could not read DBUS_SESSION_BUS_ADDRESS from /proc/${pid}/environ.`);
}

const env = gsettingsEnv({ DBUS_SESSION_BUS_ADDRESS: bus, DCONF_PROFILE: writeProfile() });

function exec(cmd: string[]): never {
  process.exit(run(cmd, env));
}

if (command === 'enable' || command === 'disable' || command === 'info' || command === 'prefs') {
  exec(['gnome-extensions', command, UUID]);
}

if (command === 'get') {
  const key = rest[0];
  if (key === undefined || rest.length !== 1) fail(`devkit:ctl: get takes one key\n\n${USAGE}`);
  exec(['gsettings', 'get', SCHEMA, key]);
}

if (command === 'set') {
  const [key, ...value] = rest;
  if (key === undefined || value.length === 0) {
    fail(`devkit:ctl: set takes a key and a value\n\n${USAGE}`);
  }
  exec(['gsettings', 'set', SCHEMA, key, value.join(' ')]);
}

if (command === 'gsettings') {
  if (rest.length === 0) fail(`devkit:ctl: gsettings takes arguments\n\n${USAGE}`);
  exec(['gsettings', ...rest]);
}

if (command === 'defaults') exec(['gsettings', 'reset-recursively', SCHEMA]);

if (command === 'eval') {
  if (rest.length === 0) fail(`devkit:ctl: eval takes a JS expression\n\n${USAGE}`);
  // `org.gnome.Shell.Eval` is a direct `eval` in ui/shellDBus.js (so `Main`
  // is in scope) that JSON-encodes the result; it returns (false, '') unless
  // the Shell was started with --unsafe-mode.
  const js = rest.join(' ');
  exec([
    'gdbus',
    'call',
    '--session',
    '--dest',
    'org.gnome.Shell',
    '--object-path',
    '/org/gnome/Shell',
    '--method',
    'org.gnome.Shell.Eval',
    js,
  ]);
}

if (command === 'fast') {
  for (const [key, value] of FAST_SCHEDULE) {
    const code = run(['gsettings', 'set', SCHEMA, key, value], env);
    if (code !== 0) fail(`devkit:ctl: gsettings set ${SCHEMA} ${key} ${value} failed (${code})`);
    console.log(`${key} = ${value}`);
  }
  process.exit(0);
}

console.error(`devkit:ctl: unknown command '${command}'\n`);
console.error(USAGE);
process.exit(1);
