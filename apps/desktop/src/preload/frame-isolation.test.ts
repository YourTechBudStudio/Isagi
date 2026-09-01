import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Electron loads a configured preload in every frame of the window, so the
 * embedded Code Server workbench runs this script too. The preload cannot be
 * imported here — it `require`s Electron and touches `document` at load — so
 * the guard is verified structurally, in the same style as the containment
 * wiring audit. Whether a real cross-origin frame observes no `window.isagi`
 * remains a phase-level obligation that only a launched Electron can settle.
 */
const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
// Prose about the guard names the very identifiers these assertions look for,
// so the audit reads the code with its comments removed.
const code = source.replace(/^\s*\/\/.*$/gmu, '');

function positionOf(needle: string) {
  const index = code.indexOf(needle);
  assert.notEqual(index, -1, `expected \`${needle}\` in preload/index.ts`);
  return index;
}

test('every preload side effect is gated behind the main-frame guard', () => {
  const guard = positionOf('if (process.isMainFrame) {');
  // Exactly one guard, and the only statements before it are the Electron
  // require, the type imports, and a constant — nothing that touches the page.
  assert.equal(code.match(/process\.isMainFrame/gu)?.length, 1);
  const preamble = code.slice(0, guard);
  assert.doesNotMatch(preamble, /document\./u);
  assert.doesNotMatch(preamble, /window\./u);
  assert.doesNotMatch(preamble, /contextBridge\.|ipcRenderer\./u);
});

test('the bridge and the document mutation reach the page only through the guard', () => {
  // Both effects are function declarations, so their only execution path is the
  // guarded block; a future call site outside it fails this assertion.
  for (const effect of ['exposeHostBridge()', 'applyHostChromeInsets'])
    assert.equal(
      code.match(new RegExp(`(?<!function )${effect.replace(/[()]/gu, '\\$&')}`, 'gu'))?.length,
      effect === 'exposeHostBridge()' ? 1 : 2,
      `${effect} must only be reachable from the main-frame guard`,
    );
  assert.equal(code.match(/contextBridge\.exposeInMainWorld\(/gu)?.length, 1);
  assert.ok(
    positionOf('function exposeHostBridge()') > positionOf('if (process.isMainFrame) {'),
    'the guard must precede the effects it gates',
  );
});
