/**
 * Shared pieces of the devkit tooling: paths, the isolated dconf profile, the
 * fast test schedule, and finding a running nested Shell.
 *
 * The devkit runs on its own D-Bus session (`dbus-run-session`) and its own
 * dconf database (`DCONF_PROFILE`), so nothing it writes can reach the live
 * session.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const UUID = 'hardbreak@melser.org';
export const SCHEMA = 'org.gnome.shell.extensions.hardbreak';

/**
 * Name of the isolated dconf database. **No hyphens**: dconf derives a D-Bus
 * object path from this name, and a hyphen makes it an invalid path — every
 * write then hangs with a `g_variant_is_object_path` critical.
 */
export const DCONF_DB = 'hardbreak_devkit';

export const root = resolve(import.meta.dir, '..');
export const dist = join(root, 'dist');
export const schemaDir = join(dist, 'schemas');
export const profilePath = join(root, 'tmp', 'devkit', 'dconf-profile');
export const dconfDbPath = join(homedir(), '.config', 'dconf', DCONF_DB);
export const extensionLink = join(homedir(), '.local', 'share', 'gnome-shell', 'extensions', UUID);

/** A short schedule that makes a full mini/long cycle testable in minutes. */
export const FAST_SCHEDULE: ReadonlyArray<readonly [key: string, value: string]> = [
  ['mini-interval', '1'],
  ['mini-duration', '20'],
  ['long-duration', '30'],
  ['mini-warning', '5'],
  ['long-warning', '10'],
  ['mini-postpone', '1'],
  ['long-postpone', '1'],
];

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Write `tmp/devkit/dconf-profile` (repo-local `tmp/` is gitignored). */
export function writeProfile(): string {
  mkdirSync(join(root, 'tmp', 'devkit'), { recursive: true });
  writeFileSync(profilePath, `user-db:${DCONF_DB}\n`);
  return profilePath;
}

/** Environment for `gsettings` calls that should hit hardbreak's own schema. */
export function gsettingsEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    // An inherited profile wins: the inner script already runs under the one
    // `devkit.ts` chose (and a throwaway profile is how the seeding is tested).
    DCONF_PROFILE: process.env['DCONF_PROFILE'] ?? profilePath,
    GSETTINGS_SCHEMA_DIR: schemaDir,
    ...extra,
  };
}

/** Run a command, inheriting stdio; return its exit code. */
export function run(cmd: string[], env: Record<string, string>): number {
  const result = Bun.spawnSync(cmd, { cwd: root, env, stdout: 'inherit', stderr: 'inherit' });
  return result.exitCode;
}

/** Run a command and abort with the failing command line if it does not succeed. */
export function runOrFail(cmd: string[], env: Record<string, string>): void {
  const result = Bun.spawnSync(cmd, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    const stdout = result.stdout.toString().trim();
    console.error(`devkit: command failed (exit ${result.exitCode}): ${cmd.join(' ')}`);
    if (stderr) console.error(stderr);
    if (stdout) console.error(stdout);
    process.exit(1);
  }
}

/** True when `schema` is installed and has `key`. */
export function hasKey(schema: string, key: string, env: Record<string, string>): boolean {
  const result = Bun.spawnSync(['gsettings', 'list-keys', schema], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) return false;
  return result.stdout.toString().split('\n').includes(key);
}

/**
 * PID of a running nested Shell, or undefined.
 *
 * Matching is on the exact argv: `pgrep -f 'gnome-shell --devkit'` also matches
 * the `dbus-run-session -- gnome-shell --devkit` parent, whose environment has
 * the *outer* bus address.
 */
export function findDevkitPid(): number | undefined {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue; // gone, or not ours
    }
    if (argv.length === 2 && argv[0]?.endsWith('gnome-shell') && argv[1] === '--devkit') {
      return Number(entry);
    }
  }
  return undefined;
}

/** The session bus address of a running nested Shell, read from its environ. */
export function devkitBusAddress(pid: number): string | undefined {
  let environ: string;
  try {
    environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return undefined;
  }
  for (const entry of environ.split('\0')) {
    if (entry.startsWith('DBUS_SESSION_BUS_ADDRESS=')) {
      return entry.slice('DBUS_SESSION_BUS_ADDRESS='.length);
    }
  }
  return undefined;
}

export function firstRun(): boolean {
  return !existsSync(dconfDbPath);
}

/**
 * The database a dconf profile file selects, as `{ name, path }`. Falls back to
 * the devkit's own db when the profile is unreadable or has no `user-db:` line.
 */
export function dbForProfile(profile: string): { name: string; path: string } {
  let name = DCONF_DB;
  try {
    for (const line of readFileSync(profile, 'utf8').split('\n')) {
      const match = /^user-db:(.+)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        name = match[1];
        break;
      }
    }
  } catch {
    // fall through to the default
  }
  return { name, path: join(homedir(), '.config', 'dconf', name) };
}
