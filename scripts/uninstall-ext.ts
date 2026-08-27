#!/usr/bin/env bun
/** Remove the installed extension — a copied directory, or an old-style symlink. */

import { lstatSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { target, UUID } from './install-common.js';

const stat = lstatSync(target, { throwIfNoEntry: false });

if (stat === undefined) {
  console.log(`nothing to do: ${target} does not exist`);
} else if (stat.isSymbolicLink()) {
  unlinkSync(target);
  console.log(`removed symlink: ${target}`);
} else if (stat.isDirectory()) {
  // Only delete a tree that says it is ours.
  let uuid: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(target, 'metadata.json'), 'utf8')) as {
      uuid?: unknown;
    };
    if (typeof parsed.uuid === 'string') uuid = parsed.uuid;
  } catch {
    uuid = undefined;
  }
  if (uuid !== UUID) {
    console.error(
      `uninstall refused: ${target} is a directory whose metadata.json ` +
        `${uuid === undefined ? 'is missing or unreadable' : `has uuid ${uuid}`} — ` +
        'it is not a hardbreak install. Remove it by hand.',
    );
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`removed: ${target}`);
} else {
  console.error(
    `uninstall refused: ${target} is neither a directory nor a symlink — remove it by hand.`,
  );
  process.exit(1);
}
