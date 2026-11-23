import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The containment decisions are unit-tested in `window-content.test.ts`. What
 * cannot be tested there is that they are actually *installed*, and installed
 * early enough: the Electron entry module runs `app.whenReady()` at import time
 * and cannot be loaded without an Electron app.
 *
 * So the wiring is verified structurally, in the same style as the IPC channel
 * audit. A future change that removes a web preference, drops a hook, or moves
 * it after the first load fails here rather than shipping an uncontained
 * window. The end-to-end suite (`e2e/`) drives the same hooks in a real app.
 */
const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');

function positionOf(needle: string) {
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, `expected \`${needle}\` in index.ts`);
  return index;
}

test('containment is installed before the runtime starts and before the first document loads', () => {
  const install = positionOf('installWindowContainment(window);');
  assert.ok(install < positionOf('startRuntime();\n  void showWindowContent(window);'));
  assert.ok(install < positionOf('void showWindowContent(window);\n}'));
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

test('the runtime CSP is the only one: the desktop rewrites no response headers', () => {
  // The UI's policy is the runtime's `webUiContentSecurityPolicy`; the loader's is its meta tag.
  assert.doesNotMatch(source, /onHeadersReceived\(/u);
  assert.doesNotMatch(source, /Content-Security-Policy/iu);
});

test("the runtime authorization hook is the default session's single, filterless onBeforeSendHeaders owner", () => {
  assert.match(
    source,
    /session\.defaultSession\.webRequest\.onBeforeSendHeaders\(\(details, callback\) =>/u,
  );
  // Exactly one registration: Electron keeps only the most recent listener per
  // event, so a second would silently displace the launcher token.
  assert.equal(source.match(/onBeforeSendHeaders\(/gu)?.length, 1);
  assert.match(
    source,
    /callback\(\{ requestHeaders: runtimeRequestHeaders\(details, target\) \}\);/u,
  );
});

test('navigation is limited to the two documents, window opening is denied, and no log names a raw URL', () => {
  assert.match(source, /window\.webContents\.on\('will-navigate'/u);
  assert.match(source, /isAllowedWindowNavigation\(\{\s*url,\s*loaderBaseUrl: loaderBase,/u);
  assert.match(
    source,
    /'will-navigate', \(details\) => \{\s*if \(isContained\(details\.url\)\) return;/u,
  );
  assert.match(source, /details\.preventDefault\(\)/u);
  assert.match(source, /setWindowOpenHandler\(\(\{ url \}\) =>/u);
  assert.match(source, /action: 'deny'/u);
  // `will-frame-navigate` would include the workbench's own iframe navigation
  // and break Code Server; its absence is deliberate.
  assert.doesNotMatch(source, /will-frame-navigate/u);

  // The loader URL carries its diagnostic, and a denied URL can carry anything: logs use coordinates.
  for (const [, argument] of source.matchAll(/console\.(?:info|warn|error)\(([^\n]*)/gu)) {
    assert.doesNotMatch(
      argument ?? '',
      /\$\{(?:details\.url|url|target|validatedURL|loaderBase|process\.env)\}/u,
      `a log must carry a coordinate, not the raw value: ${argument}`,
    );
  }
});

test('main-frame redirects are contained too, and only a failure transition overrides an unload guard', () => {
  assert.match(source, /window\.webContents\.on\('will-redirect'/u);
  assert.match(source, /if \(!details\.isMainFrame \|\| isContained\(details\.url\)\) return;/u);
  assert.match(source, /window\.webContents\.on\('will-prevent-unload'/u);
  assert.match(
    source,
    /if \(windowContent\(runtimeStatus, pageFailure\)\.kind !== 'loader'\) return;\s*event\.preventDefault\(\);/u,
  );
});

test('a main-frame UI load failure shows the failure page, and the app no longer quits on a runtime failure', () => {
  assert.match(source, /window\.webContents\.on\(\s*'did-fail-load'/u);
  assert.match(
    source,
    /pageLoadFailure\(\{\s*errorCode,\s*errorDescription,\s*url: validatedURL,\s*isMainFrame,\s*uiOrigin,?\s*\}\)/u,
  );
  assert.doesNotMatch(
    source,
    /exitAfterRuntimeFailure|requestExit\(\{ code: 1 \}\)\s*;\s*\/\/ runtime/u,
  );
});

test('the window loads exactly the URLs the policy computes, never a file path', () => {
  assert.match(source, /window\.loadURL\(target\)/u);
  assert.doesNotMatch(source, /loadFile\(/u);
});
