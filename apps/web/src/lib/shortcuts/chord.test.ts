import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesChord, parseChord, type ChordEvent } from './chord.js';

const key = (value: string, modifiers: Partial<Omit<ChordEvent, 'key'>> = {}): ChordEvent => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

test('a chord parses into its modifiers and a lowercased key', () => {
  assert.deepEqual(parseChord('Mod+K'), { mod: true, shift: false, alt: false, key: 'k' });
  assert.deepEqual(parseChord('Mod+Shift+Alt+.'), { mod: true, shift: true, alt: true, key: '.' });
});

test('a chord with no key or an unknown modifier is rejected', () => {
  assert.throws(() => parseChord('Mod+'));
  assert.throws(() => parseChord('Hyper+K'));
});

test('Mod is Meta on macOS and Control elsewhere, never both', () => {
  const modK = parseChord('Mod+K');
  assert.equal(matchesChord(modK, key('k', { metaKey: true }), true), true);
  assert.equal(matchesChord(modK, key('k', { ctrlKey: true }), true), false);
  assert.equal(matchesChord(modK, key('k', { ctrlKey: true }), false), true);
  assert.equal(matchesChord(modK, key('k', { metaKey: true }), false), false);
  assert.equal(matchesChord(modK, key('k', { ctrlKey: true, metaKey: true }), false), false);
  assert.equal(matchesChord(modK, key('k'), false), false);
});

test('the key matches regardless of case, as with Caps Lock on', () => {
  assert.equal(matchesChord(parseChord('Mod+K'), key('K', { ctrlKey: true }), false), true);
});

test('modifiers match exactly, so Mod+K never takes Mod+Shift+K or Mod+Alt+K', () => {
  const modK = parseChord('Mod+K');
  assert.equal(matchesChord(modK, key('K', { ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(matchesChord(modK, key('k', { ctrlKey: true, altKey: true }), false), false);
  assert.equal(
    matchesChord(parseChord('Mod+Shift+K'), key('K', { ctrlKey: true, shiftKey: true }), false),
    true,
  );
});

test('Shift is not compared for punctuation, whose layout decides whether it needs Shift', () => {
  assert.equal(
    matchesChord(parseChord('Mod+.'), key('.', { ctrlKey: true, shiftKey: true }), false),
    true,
  );
  assert.equal(matchesChord(parseChord('Mod+.'), key(',', { ctrlKey: true }), false), false);
});
