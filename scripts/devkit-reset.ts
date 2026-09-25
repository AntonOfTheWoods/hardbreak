#!/usr/bin/env bun
/**
 * Delete the devkit's isolated dconf database and its Evolution Data Server
 * state so the next `bun run devkit` is a first run again (fast schedule
 * reseeded, everything else back to defaults, EDS back to its built-in sources).
 *
 * Only ever touches `~/.config/dconf/hardbreak_devkit` and `tmp/devkit/eds/`;
 * the live `user` db and the live `~/.config/evolution` etc. are never
 * candidates.
 */

import { existsSync, rmSync } from 'node:fs';
import { dconfDbPath, DCONF_DB, edsDir, fail, findDevkitPid } from './devkit-common.js';

const pid = findDevkitPid();
if (pid !== undefined) {
  fail(
    `devkit:reset refused: a devkit is running (pid ${pid}) and would write its state back out.\n` +
      'Quit it first.',
  );
}

let removed = false;
if (existsSync(dconfDbPath)) {
  rmSync(dconfDbPath);
  console.log(`removed ${dconfDbPath} — the next \`bun run devkit\` reseeds ${DCONF_DB}`);
  removed = true;
}
if (existsSync(edsDir)) {
  rmSync(edsDir, { recursive: true });
  console.log(`removed ${edsDir} — the next devkit's EDS starts with its built-in sources only`);
  removed = true;
}
if (!removed) {
  console.log(
    `nothing to do: neither ${dconfDbPath} nor ${edsDir} exists (the next launch is a first run)`,
  );
}
