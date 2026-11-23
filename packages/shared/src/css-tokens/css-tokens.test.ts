import assert from 'node:assert/strict';
import test from 'node:test';

import { colorsAt, customPropertiesAt, indexAfter, stripCssComments } from './index.js';

const css = stripCssComments(`
/* a comment with { braces } */
@theme {
  --font-sans: 'Source Sans 3 Variable',
    ui-sans-serif; /* trailing */
  --color-canvas: #24273A;
}
:root[data-theme='light'] {
  --color-canvas: #e6e9ef;
  --halo-blue: color-mix(in srgb, var(--color-blue) 9%, transparent);
}
`);

test('custom properties of a block, multi-line values collapsed and comments gone', () => {
  assert.deepEqual(
    [...customPropertiesAt(css, indexAfter(css, '@theme {'))],
    [
      ['--font-sans', "'Source Sans 3 Variable', ui-sans-serif"],
      ['--color-canvas', '#24273A'],
    ],
  );
  assert.deepEqual(
    [...customPropertiesAt(css, indexAfter(css, ":root[data-theme='light'] {"))].map(
      ([name]) => name,
    ),
    ['--color-canvas', '--halo-blue'],
  );
});

test('colours only, lowercased', () => {
  assert.deepEqual(
    [...colorsAt(css, indexAfter(css, '@theme {'))],
    [['--color-canvas', '#24273a']],
  );
});

test('a missing block is an error naming it', () => {
  assert.throws(() => indexAfter(css, '.nope {'), /no "\.nope \{"/);
});
