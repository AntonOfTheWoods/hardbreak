/**
 * Shared pieces of the devkit tooling: paths, the isolated dconf profile, the
 * private bus config, the fast test schedule, and finding a running nested Shell.
 *
 * The devkit runs on its own D-Bus session (`dbus-run-session`, with Online
 * Accounts and the secret service stubbed out and Evolution Data Server on its
 * own state under `tmp/devkit/eds/`) and its own dconf database
 * (`DCONF_PROFILE`), so nothing it writes can reach the live session.
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

/** The stock session-bus config (`dbus-daemon --session`); the devkit's config includes it. */
export const SYSTEM_SESSION_CONF = '/usr/share/dbus-1/session.conf';
export const busConfigPath = join(root, 'tmp', 'devkit', 'dbus', 'session.conf');
export const busServiceDir = join(root, 'tmp', 'devkit', 'dbus', 'services');

/**
 * Well-known names that must not start on the devkit's private bus.
 *
 * - `org.gnome.OnlineAccounts`: goa-daemon reads the real
 *   `~/.config/goa-1.0/accounts.conf`, cannot reach the tokens (there is no
 *   secret service on this bus), flags every account AttentionNeeded, and the
 *   nested Shell asks you to sign in where no token can be stored.
 * - `org.freedesktop.secrets`: gnome-keyring-daemon never claims the name on a
 *   second bus, so each activation waits out the 120 s `service_start_timeout`.
 */
export const BLOCKED_BUS_NAMES = ['org.gnome.OnlineAccounts', 'org.freedesktop.secrets'] as const;

/**
 * The `.service` stub for a blocked name. Activation runs `/bin/false`, so the
 * bus replies `org.freedesktop.DBus.Error.Spawn.ChildExited` at once.
 *
 * It must be a *failing* activation, never a *missing* one. GDBusProxy swallows
 * `ServiceUnknown` and returns an ownerless proxy, so EDS's Online Accounts
 * module would connect, see zero accounts, and delete every GOA-backed source,
 * key files included. The devkit's EDS keeps its sources under `tmp/devkit/eds/`,
 * but this stays a spawn failure regardless: then the client fails to construct
 * and EDS leaves every source alone, wherever its state lives.
 */
export function stubService(name: string): string {
  return `[D-BUS Service]\nName=${name}\nExec=/bin/false\n`;
}

/**
 * Evolution Data Server's own state for the devkit. Its services run with the
 * XDG base dirs pointed here, so the sources, calendars and caches they read
 * and write are never the live session's `~/.config/evolution`,
 * `~/.cache/evolution` or `~/.local/share/evolution`. Nothing seeds it: a fresh
 * registry starts with only its built-in sources (a local "Personal" calendar
 * among them).
 */
export const edsDir = join(root, 'tmp', 'devkit', 'eds');
export const EDS_XDG: ReadonlyArray<readonly [variable: string, dir: string]> = [
  ['XDG_CONFIG_HOME', join(edsDir, 'config')],
  ['XDG_CACHE_HOME', join(edsDir, 'cache')],
  ['XDG_DATA_HOME', join(edsDir, 'data')],
];
export const EDS_NAME_PREFIX = 'org.gnome.evolution.dataserver.';

/** One activatable service: its bus name, raw `Exec=` value and the file it came from. */
export interface SessionService {
  name: string;
  exec: string;
  file: string;
}

/**
 * The directories `<standard_session_servicedirs/>` expands to, in dbus-daemon's
 * precedence order (dbus-daemon(1)): `$XDG_RUNTIME_DIR/dbus-1/services`,
 * `$XDG_DATA_HOME/dbus-1/services`, each `$XDG_DATA_DIRS` entry, then the
 * compiled-in `/usr/share/dbus-1/services`. The private dbus-daemon inherits
 * this process's environment, so it expands to the same list.
 */
export function standardSessionServiceDirs(env: Record<string, string | undefined>): string[] {
  const dirs: string[] = [];
  const runtime = env['XDG_RUNTIME_DIR'];
  if (runtime) dirs.push(runtime);
  dirs.push(env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'));
  const dataDirs = env['XDG_DATA_DIRS'] || '/usr/local/share:/usr/share';
  dirs.push(...dataDirs.split(':').filter(Boolean));
  dirs.push('/usr/share');
  const serviceDirs = dirs.map((dir) => resolve(dir, 'dbus-1', 'services'));
  return [...new Set(serviceDirs)];
}

/** `Name=` and the raw (still escaped) `Exec=` of a `[D-BUS Service]` file. */
export function parseServiceFile(text: string): { name?: string; exec?: string } {
  const result: { name?: string; exec?: string } = {};
  let group = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      group = header[1] ?? '';
      continue;
    }
    if (group !== 'D-BUS Service') continue;
    const entry = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    const [, key, value = ''] = entry ?? [];
    if (key === 'Name') result.name = value;
    if (key === 'Exec') result.exec = value;
  }
  return result;
}

/**
 * Every activatable service whose name starts with `prefix`, resolved the way
 * dbus-daemon does: the first directory providing a name wins.
 */
export function findSessionServices(prefix: string, dirs: readonly string[]): SessionService[] {
  const found = new Map<string, SessionService>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((entry) => entry.endsWith('.service'));
    } catch {
      continue; // absent or unreadable, as dbus-daemon treats it
    }
    for (const entry of entries.sort()) {
      const file = join(dir, entry);
      let parsed: { name?: string; exec?: string };
      try {
        parsed = parseServiceFile(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const { name, exec } = parsed;
      if (name === undefined || exec === undefined || !name.startsWith(prefix)) continue;
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || found.has(name)) continue;
      found.set(name, { name, exec, file });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One argument of an `Exec=` line. The value is unescaped twice: first as a
 * desktop-file value (`bus/desktop-file.c`: only `\s \t \n \r \\` are valid
 * escapes), then split like a shell command line (`dbus/dbus-shell.c`: single
 * quotes keep everything literal up to the next `'`). So a single-quoted
 * argument is exact for any text without `'`, `\` or control characters, and
 * those are refused rather than escaped.
 */
export function execArg(value: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/['\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(
      `cannot pass ${JSON.stringify(value)} through a D-Bus .service Exec= line (it contains a quote, backslash or control character); move the checkout to a plainer path`,
    );
  }
  return `'${value}'`;
}

/**
 * The devkit stub for an EDS service: the same `Exec`, run through `env` with
 * the XDG base dirs pointed at `tmp/devkit/eds/`. `GSETTINGS_BACKEND=memory`
 * because moving `XDG_CONFIG_HOME` also moves where dconf *reads* the user db
 * while its writes still go through `ca.desrt.dconf` to the devkit db; EDS
 * needs none of the devkit's settings, so it gets self-consistent defaults.
 */
export function edsStubService(service: SessionService): string {
  const env = EDS_XDG.map(([variable, dir]) => execArg(`${variable}=${dir}`)).join(' ');
  return [
    `# Generated by scripts/devkit.ts from ${service.file}; runs it on tmp/devkit/eds/.`,
    '[D-BUS Service]',
    `Name=${service.name}`,
    `Exec=/usr/bin/env ${env} GSETTINGS_BACKEND=memory ${service.exec}`,
    '',
  ].join('\n');
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * The private bus config: the stock session config with `serviceDir` listed
 * ahead of it. dbus-daemon(1): "If a particular service is found in more than
 * one <servicedir>, the first directory listed in the configuration file takes
 * precedence." An <include> merges its directories after those already listed,
 * so the stubs win and everything else (listen, auth, policy, limits, the
 * standard service dirs) is exactly `--session`.
 */
export function busConfig(serviceDir: string, sessionConf = SYSTEM_SESSION_CONF): string {
  return [
    '<!-- Generated by scripts/devkit.ts on every launch; edits are overwritten. -->',
    '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"',
    ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
    '<busconfig>',
    `  <servicedir>${xmlText(serviceDir)}</servicedir>`,
    `  <include>${xmlText(sessionConf)}</include>`,
    '</busconfig>',
    '',
  ].join('\n');
}

/**
 * Write `tmp/devkit/dbus/` (config + stubs) and create `tmp/devkit/eds/`.
 * Returns the config path and the EDS services moved onto the devkit's state.
 */
export function writeBusConfig(): { config: string; eds: string[] } {
  if (!existsSync(SYSTEM_SESSION_CONF)) {
    fail(`devkit: ${SYSTEM_SESSION_CONF} is missing, so the private bus cannot be configured.`);
  }
  const eds = findSessionServices(EDS_NAME_PREFIX, standardSessionServiceDirs(process.env));
  const stubs = new Map<string, string>();
  for (const name of BLOCKED_BUS_NAMES) stubs.set(name, stubService(name));
  try {
    for (const service of eds) stubs.set(service.name, edsStubService(service));
  } catch (err) {
    fail(`devkit: ${err instanceof Error ? err.message : String(err)}`);
  }
  mkdirSync(busServiceDir, { recursive: true });
  for (const [, dir] of EDS_XDG) mkdirSync(dir, { recursive: true });
  for (const [name, text] of stubs) writeFileSync(join(busServiceDir, `${name}.service`), text);
  writeFileSync(busConfigPath, busConfig(busServiceDir));
  return { config: busConfigPath, eds: eds.map((service) => service.name) };
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
