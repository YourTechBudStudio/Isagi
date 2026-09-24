/**
 * Media types for captured content. Pure, and deliberately small.
 *
 * A media type here is a fact about *this use* of some bytes, not about the digest that names them.
 * The same canonical bytes can legitimately be a `text/plain` capture and an `application/json`
 * payload slot, which is why nothing reads the type back off the content catalog.
 */

import { posix } from 'node:path';

/**
 * `type/subtype` with optional parameters, ASCII only.
 *
 * Syntax only. Nothing here claims the type is registered or that the bytes match it — an author
 * who labels a PNG `text/plain` has said something false, and the runtime records what they said
 * rather than second-guessing it.
 */
const mediaTypePattern =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*;[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\\\r\n]*"))*$/;

export function isMediaType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && mediaTypePattern.test(value);
}

/**
 * A guess from the extension, used only when the author did not say.
 *
 * `application/octet-stream` is the honest default: it says "bytes we will not characterise" rather
 * than inventing a type from a name. An author who knows better passes `mediaType` explicitly.
 */
const byExtension: Readonly<Record<string, string>> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export function mediaTypeForExtension(path: string): string {
  return byExtension[posix.extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * A filename extension for a media type, for the download header alone.
 *
 * The inverse of the table above, first spelling wins. An unmapped type gets no extension rather
 * than a guessed one: a name without a suffix is honest, a wrong suffix is not. Parameters are
 * dropped, so `text/plain; charset=utf-8` is still `.txt`.
 */
export function extensionForMediaType(mediaType: string): string {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  for (const [extension, type] of Object.entries(byExtension)) {
    if (type === base) return extension;
  }
  return '';
}
