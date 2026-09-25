import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCommandLine } from '@isagi/cli/commands';
import { cliErrorCodeSchema } from '@isagi/cli/error-codes';

import { isagiDocsPackageFiles } from './isagi-docs.js';

/**
 * The shipped skill and the `isagi` CLI must agree.
 *
 * An agent copies documented command lines verbatim, so every `isagi …` line in a shell example
 * must be one the CLI accepts, and every error code the CLI can print must be explained somewhere
 * an agent reading the CLI references will find it. Both rules range over every shipped
 * `references/cli-*.md`, so a new CLI reference is covered without changing this file.
 */

const files = isagiDocsPackageFiles('/Users/example/.isagi');
const markdown = [...files].filter(([path]) => path.endsWith('.md'));
const cliReferences = markdown.filter(([path]) => /^references\/cli-[^/]+\.md$/.test(path));

test('there is at least one shipped CLI reference', () => {
  assert.ok(cliReferences.length > 0);
});

test('every documented isagi command line parses against the CLI command table', () => {
  let checked = 0;
  for (const [path, source] of markdown) {
    for (const block of source.matchAll(/^```(?:sh|bash|shell)\r?\n([\s\S]*?)^```\s*$/gm)) {
      for (const line of block[1]!.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('isagi ')) continue;
        const argv = shellWords(trimmed).slice(1);
        const parsed = parseCommandLine(argv);
        assert.equal(
          parsed.kind,
          'command',
          `${path}: \`${trimmed}\` does not parse${parsed.kind === 'usage_error' ? `: ${parsed.message}` : ''}`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, 'expected documented isagi command lines');
});

test('every CLI-owned error code is documented in a CLI reference', () => {
  const text = cliReferences.map(([, source]) => source).join('\n');
  for (const code of cliErrorCodeSchema.literals) {
    assert.ok(text.includes(`\`${code}\``), `no CLI reference documents \`${code}\``);
  }
});

test('CLI references are a CLI guide, not an HTTP tutorial', () => {
  for (const [path, source] of cliReferences) {
    assert.doesNotMatch(source, /\/api\/v1/, `${path} teaches raw API routes`);
    assert.doesNotMatch(source, /\bcurl\b/, `${path} teaches raw HTTP calls`);
  }
});

/**
 * Splits one documented command line the way a POSIX shell would for these examples: whitespace
 * separates words, quotes group them, and a redirection or pipe ends the command.
 */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inWord = false;
  for (const character of line) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inWord = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
      continue;
    }
    if (
      (character === '|' || character === '>' || character === ';' || character === '#') &&
      !inWord
    ) {
      break;
    }
    current += character;
    inWord = true;
  }
  if (inWord) words.push(current);
  return words;
}
