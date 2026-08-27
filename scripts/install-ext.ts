#!/usr/bin/env bun
/** Symlink `dist/` into the user's extensions directory. */

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const UUID = 'hardbreak@melser.org';

const root = resolve(import.meta.dir, '..');
const dist = join(root, 'dist');
const extensionsDir = join(homedir(), '.local', 'share', 'gnome-shell', 'extensions');
const target = join(extensionsDir, UUID);

if (!existsSync(dist)) {
  console.error('install failed: dist/ does not exist — run `bun run build` first');
  process.exit(1);
}

mkdirSync(extensionsDir, { recursive: true });

if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
  const stat = lstatSync(target);
  if (!stat.isSymbolicLink()) {
    console.error(
      `install failed: ${target} exists and is not a symlink ` +
        `(${stat.isDirectory() ? 'directory' : 'file'}). Remove it by hand first.`,
    );
    process.exit(1);
  }
  const current = resolve(extensionsDir, readlinkSync(target));
  if (current !== dist) {
    console.error(`install failed: ${target} is a symlink to ${current}, not to ${dist}.`);
    process.exit(1);
  }
  console.log(`already installed: ${target} -> ${dist}`);
} else {
  symlinkSync(dist, target);
  console.log(`installed: ${target} -> ${dist}`);
}

console.log('');
console.log(`Next:  gnome-extensions enable ${UUID}`);
console.log('On Wayland a newly added extension is only picked up by a fresh session: log out and');
console.log('log back in before enabling it for the first time.');
