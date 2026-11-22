// Test-only helpers for reading colour tokens out of a stylesheet. Tests that keep a copy of a palette equal
// to `apps/web/src/styles.css` share these so they all read the CSS the same way; the parsing itself is
// `@isagi/shared/css-tokens`, which the desktop build also uses to generate its loader's tokens.
import { readFileSync } from 'node:fs';

import { stripCssComments } from '@isagi/shared/css-tokens';

export {
  colorsAt,
  indexAfter as after,
  isagiThemeBlocks,
  type Tokens,
} from '@isagi/shared/css-tokens';

/** Isagi's own stylesheet, the source of truth for its tokens. */
export const isagiStylesUrl = new URL('../../styles.css', import.meta.url);

/** A stylesheet's text with comments removed. */
export const read = (url: string | URL): string => stripCssComments(readFileSync(url, 'utf8'));
