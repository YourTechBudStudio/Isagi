// The runtime answers a program's colour queries (OSC 10/11) from the contracts `terminalPalette`, while the
// web terminal paints with `--color-fg` and `--color-terminal-surface` (see `terminalThemeFromTokens`). This
// keeps the two equal theme by theme, so a program sees the colours the pane actually draws.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type AppearanceTheme, terminalPalette } from '@isagi/contracts';

import {
  after,
  colorsAt,
  isagiStylesUrl,
  isagiThemeBlocks,
  read,
} from '../css-tokens/test-support.js';

const isagi = read(isagiStylesUrl);

describe('the runtime terminal palette', () => {
  for (const theme of Object.keys(isagiThemeBlocks) as AppearanceTheme[]) {
    test(`matches the ${theme} theme's terminal tokens`, () => {
      const tokens = colorsAt(isagi, after(isagi, isagiThemeBlocks[theme]));
      // `terminalThemeFromTokens` blends a fallback when the surface token is absent; requiring it here
      // keeps that fallback from silently diverging from the palette.
      assert.ok(tokens.has('--color-fg'), `no --color-fg in the ${theme} theme`);
      assert.ok(
        tokens.has('--color-terminal-surface'),
        `no --color-terminal-surface in the ${theme} theme`,
      );
      assert.deepEqual(
        {
          foreground: tokens.get('--color-fg'),
          background: tokens.get('--color-terminal-surface'),
        },
        { ...terminalPalette[theme] },
        `terminalPalette.${theme} in @isagi/contracts differs from apps/web/src/styles.css`,
      );
    });
  }
});
