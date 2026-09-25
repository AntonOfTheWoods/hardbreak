// Ambient type declarations for the gnome-shell runtime.
// Shared by the runtime build and Shell lifecycle tests. The tooling project
// checks core code and its tests separately, without these GJS declarations.
import '@girs/gjs';
import '@girs/gjs/dom';
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';
// Calendar pause (ADR 0001). Loaded at runtime with dynamic import() only.
import '@girs/ecal-2.0/ambient';
import '@girs/edataserver-1.2/ambient';
import '@girs/icalglib-3.0/ambient';
