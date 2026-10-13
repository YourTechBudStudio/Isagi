import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause } from 'effect';

import { DatabaseError } from '../../platform/persistence/index.js';
import { runtimeConfigError } from '../../runtime-config/index.js';
import { formatStartupFailure } from '../startup-diagnostics.js';

test('startup diagnostics include the typed failure and raw native cause', () => {
  const output = formatStartupFailure(
    Cause.fail(
      new DatabaseError({
        operation: 'open_database',
        cause: new Error('better-sqlite3 native module mismatch'),
      }),
    ),
  );

  assert.match(output, /ISAGI_RUNTIME_STARTUP_FAILED/);
  assert.match(output, /DatabaseError/);
  assert.match(output, /better-sqlite3 native module mismatch/);
});

test('a config failure renders its authored reason and location and no config text', () => {
  const output = formatStartupFailure(
    Cause.fail(
      runtimeConfigError('/data/config.yaml', {
        reason: 'yaml_syntax',
        yamlCode: 'BAD_INDENT',
        line: 12,
        column: 3,
      }),
    ),
  );

  assert.match(output, /RuntimeConfigError/);
  assert.match(
    output,
    /config\.yaml is not valid YAML \(BAD_INDENT at 12:3\): \/data\/config\.yaml/,
  );
});
