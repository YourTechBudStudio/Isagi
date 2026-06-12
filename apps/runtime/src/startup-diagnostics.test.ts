import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause } from 'effect';

import { DatabaseError } from './persistence/database.service.js';
import { formatStartupFailure } from './startup-diagnostics.js';

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
