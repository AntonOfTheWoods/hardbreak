#!/usr/bin/env bun
/**
 * Build `dist/`: the directory that gets symlinked into
 * `~/.local/share/gnome-shell/extensions/hardbreak@melser.org`.
 *
 * There is deliberately no bundling — gnome-shell's GJS loads the emitted ESM
 * directly, so `gi://` and `resource:///` imports must survive verbatim.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');

function fail(message: string): never {
  console.error(`build failed: ${message}`);
  process.exit(1);
}

function run(cmd: string[]): void {
  const result = Bun.spawnSync(cmd, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (result.exitCode !== 0) fail(`${cmd.join(' ')} exited with ${result.exitCode}`);
}

// 1. Clean. The install symlink points at this path, not at its inode, so
//    removing and recreating the directory does not break it.
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 2. Compile src/ -> dist/ (ESM, no bundling).
const tsc = join(root, 'node_modules', '.bin', 'tsc');
if (!existsSync(tsc)) fail('node_modules/.bin/tsc is missing — run `bun install`');
run([tsc, '-p', 'tsconfig.build.json']);

// 3. Copy the non-TypeScript parts of the extension.
for (const file of ['metadata.json', 'stylesheet.css']) {
  const from = join(root, file);
  if (!existsSync(from)) fail(`${file} is missing`);
  cpSync(from, join(dist, file));
}

const assets = join(root, 'assets');
if (!existsSync(assets)) fail('assets/ is missing');
cpSync(assets, join(dist, 'assets'), { recursive: true });

const schemas = join(root, 'schemas');
const schemaFiles = existsSync(schemas)
  ? readdirSync(schemas).filter((name) => name.endsWith('.gschema.xml'))
  : [];
if (schemaFiles.length === 0) fail('no schemas/*.gschema.xml found');
mkdirSync(join(dist, 'schemas'), { recursive: true });
for (const name of schemaFiles) cpSync(join(schemas, name), join(dist, 'schemas', name));

// 4. Compile the schema where the Shell expects it.
run(['glib-compile-schemas', '--strict', join(dist, 'schemas')]);

console.log(`built ${dist}`);
