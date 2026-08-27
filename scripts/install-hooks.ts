#!/usr/bin/env bun
/** Install the pre-commit hook (`bun run validate`). Run by `prepare`. */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const dotGit = join(root, '.git');

if (!existsSync(dotGit)) process.exit(0); // e.g. installed as a dependency, or a tarball

// `.git` is a file in worktrees and submodules; it points at the real git dir.
let gitDir = dotGit;
if (statSync(dotGit).isFile()) {
  const pointer = readFileSync(dotGit, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/.exec(pointer);
  if (match?.[1] === undefined) process.exit(0);
  gitDir = resolve(root, match[1]);
}

const hooksDir = join(gitDir, 'hooks');
mkdirSync(hooksDir, { recursive: true });

const hook = `#!/bin/sh
# Installed by scripts/install-hooks.ts. Runs the full check-default validate.
exec bun run validate
`;

const path = join(hooksDir, 'pre-commit');
writeFileSync(path, hook);
chmodSync(path, 0o755);
console.log(`installed ${path}`);
