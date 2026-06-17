import assert from 'node:assert/strict';
import { delimiter, dirname } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { launchEnv } from './runtime-namespace.js';

test('launch env includes the runtime node bin so globally installed harness commands resolve', () => {
  const env = launchEnv();
  const entries = (env.PATH ?? '').split(delimiter);
  assert.equal(entries[0], dirname(process.execPath));
});
