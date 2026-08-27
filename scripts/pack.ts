#!/usr/bin/env bun
/**
 * Build `tmp/pack/hardbreak@melser.org.shell-extension.zip`: the artefact that
 * is uploaded to extensions.gnome.org and attached to a GitHub release.
 *
 * The bundle is `dist/` — the same tree `install:ext` symlinks — so a release
 * contains exactly what has been running locally.
 *
 * Two backends produce it:
 *
 * - `gnome-extensions pack`, the canonical tool, whenever it is installed. It
 *   picks up `metadata.json`, `extension.js`, `prefs.js`, `stylesheet.css` and
 *   `schemas/*.gschema.xml` by itself; our JS lives in subdirectories, so those
 *   are passed as `--extra-source`.
 * - a plain `zip` over the same file list when it is not (CI: `gnome-extensions`
 *   only ships in the `gnome-shell` package, which is a few hundred megabytes of
 *   compositor to install on a headless runner just to write a zip).
 *
 * Which backend ran is irrelevant to the result, because the zip is verified
 * afterwards against an explicit list of files that must be there and patterns
 * that must not — a missing schema or a shipped test file fails the build.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const UUID = 'hardbreak@melser.org';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');
const outDir = join(root, 'tmp', 'pack');
const zipPath = join(outDir, `${UUID}.shell-extension.zip`);

/** Directories of emitted JS and data that `gnome-extensions pack` ignores. */
const EXTRA_SOURCES = ['core', 'shell', 'assets'];

/** Everything the extension needs at runtime. Absent = broken install. */
const REQUIRED = [
  'metadata.json',
  'extension.js',
  'prefs.js',
  'stylesheet.css',
  'schemas/org.melser.hardbreak.gschema.xml',
  'core/format.js',
  'core/ideas.js',
  'core/morning.js',
  'core/scheduler.js',
  'core/types.js',
  'core/watchdog.js',
  'shell/breakController.js',
  'shell/gjsPorts.js',
  'shell/indicator.js',
  'shell/notifier.js',
  'shell/overlay.js',
  'shell/presence.js',
  'shell/settings.js',
  'assets/ideas.json',
  'assets/crystal-glass.wav',
];

/** Present = something leaked into `dist/` that must not be published. */
const FORBIDDEN: { why: string; matches: (name: string) => boolean }[] = [
  { why: 'unit tests', matches: (name) => name.endsWith('.test.js') },
  {
    why: 'test-only scaffolding (excluded by tsconfig.build.json)',
    matches: (name) => name === 'testing.js' || name.endsWith('/testing.js'),
  },
  { why: 'scratch output', matches: (name) => name === 'tmp' || name.startsWith('tmp/') },
  { why: 'TypeScript sources', matches: (name) => name.endsWith('.ts') },
  { why: 'source maps', matches: (name) => name.endsWith('.map') },
];

function fail(message: string): never {
  console.error(`pack failed: ${message}`);
  process.exit(1);
}

function run(cmd: string[], cwd = root): void {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) fail(`${cmd.join(' ')} exited with ${result.exitCode}`);
}

function capture(cmd: string[]): string {
  const result = Bun.spawnSync(cmd, { cwd: root, stdout: 'pipe', stderr: 'inherit' });
  if (result.exitCode !== 0) fail(`${cmd.join(' ')} exited with ${result.exitCode}`);
  return result.stdout.toString();
}

// 1. A pack is always a fresh build: never ship a stale dist/.
run([process.execPath, 'run', join(root, 'scripts', 'build.ts')]);

// 2. metadata.json is what e.g.o reads first; a mismatch there wastes a review.
const metadataPath = join(dist, 'metadata.json');
if (!existsSync(metadataPath)) fail('dist/metadata.json is missing — did the build run?');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
  uuid?: string;
  version?: number;
  'shell-version'?: string[];
};
if (metadata.uuid !== UUID)
  fail(`metadata.json uuid is ${String(metadata.uuid)}, expected ${UUID}`);
if (!Array.isArray(metadata['shell-version']) || metadata['shell-version'].length === 0) {
  fail('metadata.json has no shell-version');
}
if (typeof metadata.version !== 'number') fail('metadata.json has no numeric version');

for (const name of EXTRA_SOURCES) {
  if (!existsSync(join(dist, name))) fail(`dist/${name} is missing — did the build run?`);
}

// 3. Pack.
mkdirSync(outDir, { recursive: true });
rmSync(zipPath, { force: true });

const gnomeExtensions = Bun.which('gnome-extensions');
if (gnomeExtensions) {
  run([
    gnomeExtensions,
    'pack',
    dist,
    ...EXTRA_SOURCES.map((name) => `--extra-source=${name}`),
    '--force',
    `--out-dir=${outDir}`,
  ]);
} else {
  console.log('pack: gnome-extensions is not installed, zipping dist/ directly');
  if (!Bun.which('zip')) fail('neither gnome-extensions nor zip is installed');
  // The same set gnome-extensions pack would take: its implicit files plus the
  // extra sources. `schemas/` is listed file by file so the locally compiled
  // gschemas.compiled stays out (the Shell compiles schemas at install time).
  run(
    [
      'zip',
      '--quiet',
      '-X',
      '--recurse-paths',
      zipPath,
      'metadata.json',
      'extension.js',
      'prefs.js',
      'stylesheet.css',
      'schemas/org.melser.hardbreak.gschema.xml',
      ...EXTRA_SOURCES,
    ],
    dist,
  );
}

if (!existsSync(zipPath)) fail(`${zipPath} was not created`);

// 4. Verify. This is the actual contract; the backend above is an implementation
//    detail.
if (!Bun.which('unzip')) fail('unzip is needed to verify the bundle');
const entries = capture(['unzip', '-Z1', zipPath])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => (line.endsWith('/') ? line.slice(0, -1) : line));
const present = new Set(entries);

const missing = REQUIRED.filter((name) => !present.has(name));
const forbidden = entries.flatMap((name) => {
  const rule = FORBIDDEN.find((candidate) => candidate.matches(name));
  return rule ? [`${name} (${rule.why})`] : [];
});

if (missing.length > 0 || forbidden.length > 0) {
  for (const name of missing) console.error(`  missing: ${name}`);
  for (const name of forbidden) console.error(`  must not be in the bundle: ${name}`);
  fail(`${missing.length} missing file(s), ${forbidden.length} forbidden file(s)`);
}

// 5. Report.
process.stdout.write(capture(['unzip', '-l', zipPath]));
console.log(`packed ${zipPath}`);
