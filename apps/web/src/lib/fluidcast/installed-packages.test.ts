// Guards the single physical copy of the Fluidcast player's shared peers. The packages install from
// the npm registry, so pnpm resolves their peers from Isagi's graph; a link to a Fluidcast checkout,
// or a stale install, would bring a second React or `effect` into the web bundle and its tests.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const realFrom = (from: string, specifier: string): string =>
  realpathSync(createRequire(from).resolve(specifier));

describe('installed Fluidcast player', () => {
  const player = realpathSync(
    fileURLToPath(import.meta.resolve('@yourtechbudstudio/fluidcast-react')),
  );
  for (const name of ['react', 'react-dom', 'effect', '@effect/atom-react']) {
    test(`uses the web's own ${name}`, () => {
      const theirs = realFrom(player, name);
      assert.equal(
        theirs,
        realFrom(import.meta.url, name),
        `@yourtechbudstudio/fluidcast-react resolves a second copy of ${name} (${theirs}). Install ` +
          `the Fluidcast packages from the registry, then run pnpm install.`,
      );
    });
  }
});
