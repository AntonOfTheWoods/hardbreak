import { describe, expect, test } from 'bun:test';
import { parseIdeaBook, pickIdea } from './ideas.js';
import type { IdeaBook } from './types.js';

const book: IdeaBook = {
  mini: ['Blink slowly.', 'Look out of the window.', 'Roll your shoulders.'],
  long: [
    { title: 'Walk', body: 'Go around the block.' },
    { title: 'Water', body: 'Refill your glass.' },
  ],
};

const constant = (value: number) => () => value;

describe('pickIdea', () => {
  test('a mini idea is a body with no title', () => {
    expect(pickIdea(book, 'mini', constant(0))).toEqual({ body: 'Blink slowly.' });
  });

  test('a long idea has both a title and a body', () => {
    expect(pickIdea(book, 'long', constant(0))).toEqual({
      title: 'Walk',
      body: 'Go around the block.',
    });
  });

  test('the whole list is reachable and nothing runs off the end', () => {
    expect(pickIdea(book, 'mini', constant(0.99999)).body).toBe('Roll your shoulders.');
    expect(pickIdea(book, 'mini', constant(0.5)).body).toBe('Look out of the window.');
    // A degenerate rng that returns exactly 1 must not index past the end.
    expect(pickIdea(book, 'mini', constant(1)).body).toBe('Roll your shoulders.');
    expect(pickIdea(book, 'long', constant(1)).title).toBe('Water');
  });

  test('falls back when the list is empty', () => {
    const empty: IdeaBook = { mini: [], long: [] };
    expect(pickIdea(empty, 'mini').body.length).toBeGreaterThan(0);
    expect(pickIdea(empty, 'mini').title).toBeUndefined();
    const long = pickIdea(empty, 'long');
    expect(long.title).toBe('Take a break');
    expect(long.body.length).toBeGreaterThan(0);
  });

  test('defaults to Math.random and stays inside the list', () => {
    const bodies = new Set<string>();
    for (let i = 0; i < 200; i++) bodies.add(pickIdea(book, 'mini').body);
    expect([...bodies].every((body) => book.mini.includes(body))).toBe(true);
  });
});

describe('parseIdeaBook', () => {
  test('accepts the bundled shape', () => {
    expect(parseIdeaBook({ mini: ['a'], long: [{ title: 't', body: 'b' }] })).toEqual({
      mini: ['a'],
      long: [{ title: 't', body: 'b' }],
    });
  });

  test('drops malformed entries instead of throwing', () => {
    expect(
      parseIdeaBook({
        mini: ['a', '', 3, null],
        long: [{ title: 't', body: 'b' }, { title: 't' }, 'nope', null, { title: 1, body: 2 }],
      }),
    ).toEqual({ mini: ['a'], long: [{ title: 't', body: 'b' }] });
  });

  test('survives rubbish', () => {
    const empty = { mini: [], long: [] };
    expect(parseIdeaBook(null)).toEqual(empty);
    expect(parseIdeaBook('nope')).toEqual(empty);
    expect(parseIdeaBook({})).toEqual(empty);
    expect(parseIdeaBook({ mini: 'a', long: 7 })).toEqual(empty);
  });
});
