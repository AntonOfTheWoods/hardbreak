import { expect, test } from 'bun:test';
import { versionName } from './version-name.js';

test('release tags retain their semantic version', () => {
  expect(versionName('v1.2.3')).toBe('1.2.3');
});

test('git descriptions and prerelease tags produce EGO-compatible labels', () => {
  expect(versionName('v1.0.1-2-g2793fe6')).toBe('1.0.1.2.g2793fe6');
  expect(versionName('v2.0.0-beta.1')).toBe('2.0.0.beta.1');
  expect(versionName('v2.0.0+build_42')).toBe('2.0.0.build.42');
});

test('long descriptions fit the display limit', () => {
  const label = versionName('v1.0.1-1234-g2793fe6');
  expect(label).toHaveLength(16);
  expect(label).toMatch(/^(?!^[. ]+$)[a-zA-Z0-9 .]{1,16}$/);
});

test('empty or punctuation-only descriptions do not produce invalid labels', () => {
  for (const description of ['', 'v', '__', '. .', '................1'])
    expect(versionName(description)).toBeUndefined();
});
