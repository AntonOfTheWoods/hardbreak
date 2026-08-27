#!/usr/bin/env bun
/** Copy `dist/` into the user's extensions directory. */

import { dist, installDist, target, UUID } from './install-common.js';

const outcome = installDist();
if (!outcome.ok) {
  console.error(`install failed: ${outcome.error}`);
  process.exit(1);
}

switch (outcome.action) {
  case 'installed':
    console.log(`installed: ${dist} -> ${target}`);
    break;
  case 'replaced-directory':
    console.log(`reinstalled: ${dist} -> ${target} (previous install removed)`);
    break;
  case 'replaced-symlink':
    console.log(`installed: ${dist} -> ${target}`);
    console.log(
      'the previous install was a symlink to dist/ (the old scheme) — it has been unlinked ' +
        'and replaced by a copy',
    );
    break;
}

console.log('');
console.log(`Next:  gnome-extensions enable ${UUID}`);
console.log('On Wayland a newly added extension is only picked up by a fresh session: log out and');
console.log('log back in before enabling it for the first time.');
console.log('');
console.log(
  'The install is a copy: rebuilding does not change it, and the running Shell keeps the',
);
console.log('code it already loaded — log out and back in to pick up this install (prefs and the');
console.log('Extensions app pick it up when they are restarted).');
