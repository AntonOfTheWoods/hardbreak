#!/usr/bin/env bun
/**
 * Delete the devkit's isolated dconf database so the next `bun run devkit` is a
 * first run again (fast schedule reseeded, everything else back to defaults).
 *
 * Only ever touches `~/.config/dconf/hardbreak_devkit`; the live `user` db is
 * never a candidate.
 */

import { existsSync, rmSync } from 'node:fs';
import { dconfDbPath, DCONF_DB, fail, findDevkitPid } from './devkit-common.js';

const pid = findDevkitPid();
if (pid !== undefined) {
  fail(
    `devkit:reset refused: a devkit is running (pid ${pid}) and would write the db back out.\n` +
      'Quit it first.',
  );
}

if (!existsSync(dconfDbPath)) {
  console.log(`nothing to do: ${dconfDbPath} does not exist (the next launch is a first run)`);
  process.exit(0);
}

rmSync(dconfDbPath);
console.log(`removed ${dconfDbPath} — the next \`bun run devkit\` reseeds ${DCONF_DB}`);
