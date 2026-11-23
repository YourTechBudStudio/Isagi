import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loaderTokens } from './build-loader.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const styles = readFileSync(resolve(desktopRoot, '../web/src/styles.css'), 'utf8');
const loaderCss = readFileSync(resolve(desktopRoot, 'src/loader/loader.css'), 'utf8');

test('the loader names no palette value: every variable it reads is generated from styles.css, in both themes', () => {
  const { tokensCss } = loaderTokens(styles);
  const [dark, light] = tokensCss.split(":root[data-theme='light']");
  const used = new Set([...loaderCss.matchAll(/var\((--[\w-]+)\)/gu)].map(([, name]) => name));
  assert.ok(used.size > 10);
  for (const name of used) assert.match(dark ?? '', new RegExp(`\\n  ${name}: `, 'u'), name);
  // Light overrides every colour and halo the loader paints with.
  for (const name of used) {
    if (name.startsWith('--color-') || name.startsWith('--halo-')) {
      const derived = name === '--color-error';
      if (!derived) assert.match(light ?? '', new RegExp(`\\n  ${name}: `, 'u'), name);
    }
  }
  assert.doesNotMatch(
    loaderCss.replaceAll(/\/\*[\s\S]*?\*\//gu, ''),
    /#[0-9a-f]{6}\b/iu,
    'no hand-copied hex colour',
  );
});

test('the window backgrounds are the two canvas colours', () => {
  assert.deepEqual(loaderTokens(styles).backgrounds, { dark: '#24273a', light: '#e6e9ef' });
  assert.throws(
    () => loaderTokens(styles.replace('--color-canvas: #24273a;', '--color-canvas: var(--x);')),
    /not a #rrggbb literal/,
  );
});
