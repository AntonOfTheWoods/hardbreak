/** Idea selection for the overlay. Pure so it is unit-testable. */

import type { BreakKind, Idea, IdeaBook, LongIdea } from './types.js';

const FALLBACK_MINI = 'Look away from the screen and let your eyes relax.';
const FALLBACK_LONG: LongIdea = {
  title: 'Take a break',
  body: 'Stand up, stretch, and look at something far away for a while.',
};

function indexFor(length: number, rng: () => number): number {
  const raw = Math.floor(rng() * length);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(length - 1, raw);
}

/**
 * Pick a random idea for `kind`. Mini breaks get a body only; long breaks get a
 * title and a body. Falls back to a built-in idea when the list is empty, so an
 * edited or truncated `ideas.json` can never blank the overlay.
 */
export function pickIdea(ideas: IdeaBook, kind: BreakKind, rng: () => number = Math.random): Idea {
  if (kind === 'mini') {
    const list = ideas.mini;
    if (list.length === 0) return { body: FALLBACK_MINI };
    return { body: list[indexFor(list.length, rng)] ?? FALLBACK_MINI };
  }
  const list = ideas.long;
  const chosen =
    list.length === 0 ? FALLBACK_LONG : (list[indexFor(list.length, rng)] ?? FALLBACK_LONG);
  return { title: chosen.title, body: chosen.body };
}

/**
 * Validate parsed JSON into an {@link IdeaBook}, dropping anything malformed.
 * The Shell side reads the file; this keeps the shape checking testable.
 */
export function parseIdeaBook(value: unknown): IdeaBook {
  const book: IdeaBook = { mini: [], long: [] };
  if (typeof value !== 'object' || value === null) return book;
  const record = value as Record<string, unknown>;
  const mini = record['mini'];
  if (Array.isArray(mini)) {
    for (const entry of mini) if (typeof entry === 'string' && entry !== '') book.mini.push(entry);
  }
  const long = record['long'];
  if (Array.isArray(long)) {
    for (const entry of long) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { title, body } = entry as Record<string, unknown>;
      if (typeof title === 'string' && typeof body === 'string' && body !== '') {
        book.long.push({ title, body });
      }
    }
  }
  return book;
}
