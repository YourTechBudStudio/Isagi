// Version guard for the linked Fluidcast packages. They resolve their own `effect` and
// `@effect/ai-openai` from the Fluidcast checkout (by real path), so the runtime runs two physical
// copies of each. Two copies of one version interoperate; two different versions are not proven to,
// and the catalogs can drift apart (Fluidcast uses `^` ranges). This pins equality instead of
// deduplicating.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** The version of `name` as resolved from `from` (a file path or URL). */
const versionFrom = (from: string, name: string): string => {
  const manifest = createRequire(from).resolve(`${name}/package.json`);
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { readonly version: string }).version;
};

/** A linked entry's real location in the Fluidcast checkout, where its own dependencies resolve. */
const linked = (entry: string): string => realpathSync(fileURLToPath(import.meta.resolve(entry)));

const pairs = [
  { name: 'effect', fluidcast: '@yourtechbudstudio/fluidcast-harness' },
  { name: '@effect/ai-openai', fluidcast: '@yourtechbudstudio/fluidcast-core/speech/openai' },
] as const;

describe('linked Fluidcast packages', () => {
  for (const { name, fluidcast } of pairs) {
    test(`${fluidcast} resolves the same ${name} version as the runtime`, () => {
      const isagi = versionFrom(import.meta.url, name);
      const theirs = versionFrom(linked(fluidcast), name);
      assert.equal(
        theirs,
        isagi,
        `${name} drifted: Isagi resolves ${isagi}, but ${fluidcast} resolves ${theirs}. Align the ` +
          `two catalogs (Isagi's pnpm-workspace.yaml and Fluidcast's), then reinstall Fluidcast ` +
          `(pnpm -C .fluidcast install) and Isagi (pnpm install).`,
      );
    });
  }
});
