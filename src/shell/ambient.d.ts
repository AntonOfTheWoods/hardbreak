// Ambient type declarations for the gnome-shell runtime.
// Included by tsconfig.build.json only (src/core/** must stay GJS-free, so
// tsconfig.json, which covers core + tests, never picks this file up).
import '@girs/gjs';
import '@girs/gjs/dom';
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';
