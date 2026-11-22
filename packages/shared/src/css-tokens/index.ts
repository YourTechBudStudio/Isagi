// Reading design tokens out of a stylesheet's text. Pure string parsing, no filesystem: the web tests that keep a
// palette equal to `apps/web/src/styles.css` and the desktop build that generates the loader's tokens from it both
// read the CSS through these, so there is one parser.

/** Custom property name → value, in declaration order. */
export type Tokens = ReadonlyMap<string, string>;

/** The selector text that opens each Isagi theme's colour block in `apps/web/src/styles.css`, keyed by theme. */
export const isagiThemeBlocks = {
  /** Tailwind's `@theme`: the dark (Macchiato) values of every Tailwind token namespace. */
  dark: '@theme {',
  /** Every light (Latte) override, Tailwind namespaces and the rest alike. */
  light: ":root[data-theme='light'] {",
} as const;

/** The dark theme's values that are not Tailwind namespaces (halos, shadow colours, terminal neutrals). */
export const isagiDarkRootBlock = ':root {';

/** A stylesheet's text with comments removed. */
export function stripCssComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

/** The index just past the first `text`, which must be there. */
export function indexAfter(css: string, text: string): number {
  const at = css.indexOf(text);
  if (at === -1) throw new Error(`no "${text}" in the stylesheet`);
  return at + text.length;
}

/**
 * The custom-property declarations of the block around `at`, values trimmed and whitespace-collapsed. Blocks holding
 * tokens nest nothing, so the block is the text between the nearest `{` before `at` and the first `}` after it.
 */
export function customPropertiesAt(css: string, at: number): Tokens {
  const block = css.slice(css.lastIndexOf('{', at) + 1, css.indexOf('}', at));
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name!,
      value!.trim().replaceAll(/\s+/g, ' '),
    ]),
  );
}

/** The `--color-*` declarations of the block around `at`, values lowercased for comparison. */
export function colorsAt(css: string, at: number): Tokens {
  return new Map(
    [...customPropertiesAt(css, at)]
      .filter(([name]) => name.startsWith('--color-'))
      .map(([name, value]) => [name, value.toLowerCase()]),
  );
}
