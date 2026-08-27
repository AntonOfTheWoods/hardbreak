/**
 * Installing `dist/` into the user's extensions directory, shared by
 * `install-ext.ts` and the `devkit.ts` preflight.
 *
 * The install is a **copy**, not a symlink. A symlinked install makes every
 * `bun run build` mutate the extension the live Shell, the Extensions app and
 * the prefs process are reading — renaming a schema key under a running prefs
 * dialog is enough to break it mid-session. With a copy, `dist/` is scratch and
 * the installed tree only changes when someone asks for it.
 *
 * The swap is atomic-ish by construction: the new tree is copied to a hidden
 * sibling directory first and only then `rename(2)`d into place, so the target
 * is never a half-written tree.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const UUID = 'hardbreak@melser.org';

export const root = resolve(import.meta.dir, '..');
export const dist = join(root, 'dist');
export const extensionsDir = join(homedir(), '.local', 'share', 'gnome-shell', 'extensions');
export const target = join(extensionsDir, UUID);

/**
 * What an install did, or why it refused. Callers own the exit code and the
 * wording around it; nothing here throws or exits.
 */
export type InstallOutcome =
  | { ok: true; action: 'installed' | 'replaced-directory' | 'replaced-symlink' }
  | { ok: false; error: string };

/** The `uuid` of `<dir>/metadata.json`, or undefined if it is missing/unreadable. */
function metadataUuid(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as {
      uuid?: unknown;
    };
    return typeof parsed.uuid === 'string' ? parsed.uuid : undefined;
  } catch {
    return undefined;
  }
}

function describe(dir: string): string {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) return 'missing';
  if (stat.isSymbolicLink()) return 'a symlink';
  if (stat.isDirectory()) return 'a directory';
  if (stat.isFile()) return 'a file';
  return 'neither a file nor a directory';
}

/**
 * Copy `dist/` over `~/.local/share/gnome-shell/extensions/<uuid>`.
 *
 * Refuses when there is no build to install, and when the existing target is
 * something other than an old-style symlink or a directory that is recognisably
 * ours (a `metadata.json` carrying our uuid) — nothing else is safe to delete.
 */
export function installDist(): InstallOutcome {
  if (!existsSync(join(dist, 'metadata.json'))) {
    return {
      ok: false,
      error: `${join(dist, 'metadata.json')} is missing — run \`bun run build\``,
    };
  }
  const built = metadataUuid(dist);
  if (built !== UUID) {
    return {
      ok: false,
      error: `${join(dist, 'metadata.json')} has uuid ${String(built)}, expected ${UUID}`,
    };
  }

  mkdirSync(extensionsDir, { recursive: true });

  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isSymbolicLink() && !existing.isDirectory()) {
    return { ok: false, error: `${target} is ${describe(target)} — remove it by hand first` };
  }
  if (existing?.isDirectory() === true) {
    const installed = metadataUuid(target);
    if (installed !== UUID) {
      return {
        ok: false,
        error:
          `${target} is a directory whose metadata.json ` +
          `${installed === undefined ? 'is missing or unreadable' : `has uuid ${installed}`} — ` +
          `it is not a hardbreak install, refusing to replace it`,
      };
    }
  }

  const staging = join(extensionsDir, `.${UUID}.tmp-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    cpSync(dist, staging, { recursive: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `could not copy ${dist} to ${staging}: ${String(error)}` };
  }

  try {
    if (existing === undefined) {
      renameSync(staging, target);
      return { ok: true, action: 'installed' };
    }
    if (existing.isSymbolicLink()) {
      unlinkSync(target);
      renameSync(staging, target);
      return { ok: true, action: 'replaced-symlink' };
    }

    // Directory: move it aside rather than deleting it, so a failed rename can
    // still be undone, and only remove it once the new tree is in place.
    const old = `${target}.old-${process.pid}`;
    rmSync(old, { recursive: true, force: true });
    renameSync(target, old);
    try {
      renameSync(staging, target);
    } catch (error) {
      renameSync(old, target);
      throw error;
    }
    rmSync(old, { recursive: true, force: true });
    return { ok: true, action: 'replaced-directory' };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: `could not install ${dist} to ${target}: ${String(error)}` };
  }
}
