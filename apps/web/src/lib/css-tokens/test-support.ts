// Test-only helpers for reading colour tokens out of a stylesheet. Tests that keep a copy of a palette equal
// to `apps/web/src/styles.css` share these so they all read the CSS the same way.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export type Tokens = ReadonlyMap<string, string>;

/** Isagi's own stylesheet, the source of truth for its tokens. */
export const isagiStylesUrl = new URL('../../styles.css', import.meta.url);

/** A stylesheet's text with comments removed. */
export const read = (url: string | URL): string =>
  readFileSync(url, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');

/** The `--color-*` declarations of the block around `at`; blocks holding tokens nest nothing. */
export const colorsAt = (css: string, at: number): Tokens =>
  new Map(
    [
      ...css
        .slice(css.lastIndexOf('{', at) + 1, css.indexOf('}', at))
        .matchAll(/(--color-[\w-]+):\s*([^;]+);/g),
    ].map(([, name, value]) => [name!, value!.trim().toLowerCase()]),
  );

/** The index just past the first `text`, which must be there. */
export const after = (css: string, text: string): number => {
  const at = css.indexOf(text);
  assert.notEqual(at, -1, `no "${text}"`);
  return at + text.length;
};

/** The selector text that opens each Isagi theme's token block in `styles.css`. */
export const isagiThemeBlocks = {
  dark: '@theme {',
  light: ":root[data-theme='light'] {",
} as const;
