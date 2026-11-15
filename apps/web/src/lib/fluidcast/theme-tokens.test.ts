// Isagi and the Fluidcast player each own the same Catppuccin palette, and Isagi only picks the theme
// (`data-theme` on the root, which the player follows). This keeps the two copies equal, token by
// token and theme by theme, so the player never drifts from the app around it.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  after,
  colorsAt,
  isagiStylesUrl,
  isagiThemeBlocks,
  read,
  type Tokens,
} from '../css-tokens/test-support.js';

const isagi = read(isagiStylesUrl);
const player = read(
  fileURLToPath(import.meta.resolve('@yourtechbudstudio/fluidcast-react/styles.css')),
);

const THEMES: ReadonlyArray<readonly [string, Tokens, Tokens]> = [
  // The player's compiled theme is the block Tailwind emits for its scope root, the first to set the canvas.
  [
    'dark',
    colorsAt(isagi, after(isagi, isagiThemeBlocks.dark)),
    colorsAt(player, after(player, '--color-canvas:')),
  ],
  [
    'light',
    colorsAt(isagi, after(isagi, isagiThemeBlocks.light)),
    colorsAt(player, after(player, "[data-theme='light'] :scope {")),
  ],
];

describe('the Fluidcast player palette', () => {
  for (const [theme, ours, theirs] of THEMES) {
    test(`matches Isagi's ${theme} theme for every token both define`, () => {
      // Aliases (`--color-working: var(--color-violet)`) follow the colour they name.
      const shared = [...theirs.keys()].filter(
        (name) => ours.has(name) && !theirs.get(name)!.startsWith('var('),
      );
      assert.ok(shared.includes('--color-canvas') && shared.includes('--color-blue'));
      assert.deepEqual(
        shared.filter((name) => ours.get(name) !== theirs.get(name)),
        [],
        `the installed @yourtechbudstudio/fluidcast-react ${theme} palette differs from apps/web/src/styles.css`,
      );
    });
  }
});
