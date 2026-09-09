#!/usr/bin/env bun
/**
 * Build `dist/`: the tree `scripts/install-ext.ts` copies into
 * `~/.local/share/gnome-shell/extensions/hardbreak@melser.org`.
 *
 * There is deliberately no bundling — gnome-shell's GJS loads the emitted ESM
 * directly, so `gi://` and `resource:///` imports must survive verbatim.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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

// 1. Clean. `dist/` is scratch: the install is a copy, so wiping and rebuilding
//    it leaves the installed extension alone until `install:ext` runs again.
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 2. Compile src/ -> dist/ (ESM, no bundling).
const tsc = join(root, 'node_modules', '.bin', 'tsc');
if (!existsSync(tsc)) fail('node_modules/.bin/tsc is missing — run `bun install`');
run([tsc, '-p', 'tsconfig.build.json']);

// 3. Drop `core/types.js`. `src/core/types.ts` exports types and nothing else, so
//    tsc emits an empty module that no emitted file imports — and e.g.o's review
//    tooling rejects JS that is unreachable from extension.js / prefs.js
//    (EGO-P-007). Deleting an emitted file is only safe while both of those
//    remain true, so neither is assumed: if `types.ts` ever grows a runtime
//    export, or anything ever imports it at runtime, the build stops instead of
//    quietly shipping a broken bundle.
const emittedJs = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => join(entry.parentPath, entry.name));

const typesJs = join(dist, 'core', 'types.js');
if (!existsSync(typesJs)) fail('dist/core/types.js is missing — did tsc run?');

// (a) It must carry no runtime statements: comments and a bare `export {}` only.
const residue = readFileSync(typesJs, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, '')
  .trim();
if (residue.length > 0) {
  fail(
    'dist/core/types.js has runtime statements, so it can no longer be dropped — ' +
      `keep it and update scripts/pack.ts. Found: ${JSON.stringify(residue.slice(0, 120))}`,
  );
}

// (b) Nothing may import it. Any `types.js` specifier at all is a failure: the
//     only module of that name in the tree is this one.
const importers = emittedJs.filter(
  (file) =>
    file !== typesJs &&
    /(?:from|import)\s*\(?\s*['"][^'"]*types\.js['"]/.test(readFileSync(file, 'utf8')),
);
if (importers.length > 0) {
  fail(
    `dist/core/types.js is imported at runtime by ${importers
      .map((file) => relative(dist, file))
      .join(', ')} — it must not be dropped`,
  );
}

rmSync(typesJs);

// 4. Copy the non-TypeScript parts of the extension.
for (const file of ['metadata.json', 'stylesheet.css', 'LICENSE']) {
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

// 5. Compile the schema where the Shell expects it.
run(['glib-compile-schemas', '--strict', join(dist, 'schemas')]);

console.log(`built ${dist}`);
