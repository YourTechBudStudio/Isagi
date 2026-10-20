// Guards the single physical copy of the Fluidcast packages' shared peers. Two copies of `effect`
// do not interoperate: Isagi's `Schema` rejects SDK schemas that carry a check (an `Int` cursor in
// every Snapshot). The packages therefore install from the npm registry, so pnpm resolves their peers
// from Isagi's graph. A link to a Fluidcast checkout, or a stale install, would bring Fluidcast's own
// copies back.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** A module's real location, resolved from `from` (a file path or URL). */
const realFrom = (from: string, specifier: string): string =>
  realpathSync(createRequire(from).resolve(specifier));

const shared = [
  { name: 'effect', fluidcast: '@yourtechbudstudio/fluidcast-harness' },
  {
    name: '@effect/ai-openai/OpenAiClient',
    fluidcast: '@yourtechbudstudio/fluidcast-core/speech/openai',
  },
  // `tool-agent`'s peer: the copy the Claude worker runs, and the runtime bundle carries.
  {
    name: '@anthropic-ai/claude-agent-sdk',
    fluidcast: '@yourtechbudstudio/fluidcast-tool-agent/claude',
  },
] as const;

describe('installed Fluidcast packages', () => {
  for (const { name, fluidcast } of shared) {
    test(`${fluidcast} uses the runtime's own ${name}`, () => {
      const installed = realpathSync(fileURLToPath(import.meta.resolve(fluidcast)));
      const theirs = realFrom(installed, name);
      const ours = realFrom(import.meta.url, name);
      assert.equal(
        theirs,
        ours,
        `${fluidcast} resolves a second copy of ${name} (${theirs}). Install the Fluidcast packages ` +
          `from the registry, then run pnpm install.`,
      );
    });
  }
});
