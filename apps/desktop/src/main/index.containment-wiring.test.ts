import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The containment decisions are unit-tested in `renderer-policy.test.ts`. What
 * cannot be tested there is that they are actually *installed*, and installed
 * early enough: the Electron entry module runs `app.whenReady()` at import time
 * and cannot be loaded without an Electron app.
 *
 * So the wiring is verified structurally, in the same style as the IPC channel
 * audit. A future change that removes a web preference, drops a policy, or
 * moves the hook after the renderer load fails here rather than shipping an
 * uncontained frame.
 */
const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

function positionOf(needle: string) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `expected \`${needle}\` in index.ts`);
  return index;
}

test('containment is installed before the runtime starts and before the renderer loads', () => {
  const install = positionOf('installRendererContainment(window, target)');
  assert.ok(install < positionOf('startRuntime();'), 'containment must precede startRuntime()');
  assert.ok(
    install < positionOf('yield* loadRenderer(window, target)'),
    'containment must precede loadRenderer()',
  );
});

test('the window asserts subframe and webview isolation without naming webSecurity', () => {
  const preferences = source.slice(positionOf('webPreferences: {'), positionOf('width: 1280'));
  for (const preference of [
    'contextIsolation: true',
    'nodeIntegration: false',
    'nodeIntegrationInSubFrames: false',
    'webviewTag: false',
  ])
    assert.match(
      preferences,
      new RegExp(preference.replace(/[:]/gu, '\\s*:\\s*'), 'u'),
      preference,
    );
  // Naming it would suggest it is tunable; leaving it out keeps Electron's
  // enabled default and gives no one a knob to reach for.
  assert.doesNotMatch(source, /webSecurity\s*:/u);
});

test('the header hook is the session-scoped, filterless, single owner', () => {
  assert.match(
    source,
    /window\.webContents\.session\.webRequest\.onHeadersReceived\(\(details, callback\) =>/u,
  );
  // Exactly one registration: Electron keeps only the most recent listener, so
  // a second one anywhere in the entry module would displace this policy.
  assert.equal(source.match(/onHeadersReceived\(/gu)?.length, 1);
  // The callback runs once, unconditionally, on whichever decision came back.
  assert.match(source, /callback\(decision\.response\);/u);
});

test('navigation and window opening are both denied, and neither logs a raw URL', () => {
  assert.match(source, /window\.webContents\.on\('will-navigate'/u);
  assert.match(source, /details\.preventDefault\(\)/u);
  assert.match(source, /setWindowOpenHandler\(\(\{ url \}\) =>/u);
  assert.match(source, /action: 'deny'/u);
  // `will-frame-navigate` would include the workbench's own iframe navigation
  // and break Code Server; its absence is deliberate.
  assert.doesNotMatch(source, /will-frame-navigate/u);

  for (const [, argument] of source.matchAll(/console\.(?:info|warn|error)\(([^\n]*)/gu)) {
    if (!/denied renderer|ISAGI_RUNTIME_URL/u.test(argument ?? '')) continue;
    assert.doesNotMatch(
      argument ?? '',
      /\$\{(?:details\.url|url|process\.env)/u,
      `a denial log must carry a coordinate, not the raw value: ${argument}`,
    );
  }
});

test('the renderer is loaded by the same URL the policy is scoped to', () => {
  assert.match(source, /window\.loadURL\(documentUrl\)/u);
  // `loadFile` would re-derive the path-to-URL conversion independently.
  assert.doesNotMatch(source, /loadFile\(/u);
});
