#!/usr/bin/env bun
/** Remove the `dist/` symlink from the user's extensions directory. */

import { lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID = 'hardbreak@melser.org';
const target = join(homedir(), '.local', 'share', 'gnome-shell', 'extensions', UUID);

const stat = lstatSync(target, { throwIfNoEntry: false });
if (stat === undefined) {
  console.log(`nothing to do: ${target} does not exist`);
} else if (!stat.isSymbolicLink()) {
  console.error(`uninstall refused: ${target} is not a symlink — remove it by hand.`);
  process.exit(1);
} else {
  unlinkSync(target);
  console.log(`removed: ${target}`);
}
