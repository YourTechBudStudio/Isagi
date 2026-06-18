import assert from 'node:assert/strict';
import { delimiter, dirname } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { launchEnv } from './runtime-namespace.js';

const nodeBin = dirname(process.execPath);

// `launchEnv` reads the ambient `process.env.PATH`, so drive each branch with a
// controlled PATH and restore it afterwards. This keeps the assertions independent
// of how node itself was launched (e.g. pnpm already places the node bin on PATH).
function withPath<T>(value: string | undefined, run: () => T): T {
  const original = process.env.PATH;
  if (value === undefined) delete process.env.PATH;
  else process.env.PATH = value;
  try {
    return run();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

test('launch env prepends the runtime node bin when PATH lacks it', () => {
  const entries = withPath(['/usr/bin', '/bin'].join(delimiter), () =>
    (launchEnv().PATH ?? '').split(delimiter),
  );
  assert.deepEqual(entries, [nodeBin, '/usr/bin', '/bin']);
});

test('launch env keeps the runtime node bin present without duplicating it', () => {
  const entries = withPath(['/usr/bin', nodeBin, '/bin'].join(delimiter), () =>
    (launchEnv().PATH ?? '').split(delimiter),
  );
  // Already-present node bin stays in place rather than being prepended again.
  assert.deepEqual(entries, ['/usr/bin', nodeBin, '/bin']);
});

test('launch env falls back to just the runtime node bin when PATH is unset', () => {
  const path = withPath(undefined, () => launchEnv().PATH);
  assert.equal(path, nodeBin);
});
