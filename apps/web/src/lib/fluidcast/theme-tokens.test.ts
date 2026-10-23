// Isagi and the Fluidcast player each own the same Catppuccin palette, and Isagi only picks the theme
// (`data-theme` on the root, which the player follows). This keeps the two copies equal, token by
// token and theme by theme, so the player never drifts from the app around it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

type Tokens = ReadonlyMap<string, string>;

const read = (url: string | URL): string =>
  readFileSync(url, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');

/** The `--color-*` declarations of the block around `at`; blocks holding tokens nest nothing. */
const colorsAt = (css: string, at: number): Tokens =>
  new Map(
    [
      ...css
        .slice(css.lastIndexOf('{', at) + 1, css.indexOf('}', at))
        .matchAll(/(--color-[\w-]+):\s*([^;]+);/g),
    ].map(([, name, value]) => [name!, value!.trim().toLowerCase()]),
  );

/** The index just past the first `text`, which must be there. */
const after = (css: string, text: string): number => {
  const at = css.indexOf(text);
  assert.notEqual(at, -1, `no "${text}"`);
  return at + text.length;
};

const isagi = read(new URL('../../styles.css', import.meta.url));
const player = read(
  fileURLToPath(import.meta.resolve('@yourtechbudstudio/fluidcast-react/styles.css')),
);

const THEMES: ReadonlyArray<readonly [string, Tokens, Tokens]> = [
  // The player's compiled theme is the block Tailwind emits for its scope root, the first to set the canvas.
  [
    'dark',
    colorsAt(isagi, after(isagi, '@theme {')),
    colorsAt(player, after(player, '--color-canvas:')),
  ],
  [
    'light',
    colorsAt(isagi, after(isagi, ":root[data-theme='light'] {")),
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
