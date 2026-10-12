import assert from 'node:assert/strict';
import test from 'node:test';

import { Schema } from 'effect';

import { describeOperationalCause } from '../diagnostics/index.js';
import { DatabaseError } from './database.js';

const SENTINEL = 'SUPERSECRETTOKEN12345';

test('a database error renders its operation name and a classified cause', () => {
  assert.equal(
    describeOperationalCause(
      new DatabaseError({ operation: 'find_pty_process', cause: new Error(SENTINEL) }),
    ),
    'Database operation find_pty_process failed: Error',
  );

  // The proven value-echoing case: a schema decode failure beneath a database
  // operation is named, and its message is never rendered.
  let failure: unknown;
  try {
    Schema.decodeUnknownSync(Schema.Struct({ token: Schema.Number }))({ token: SENTINEL });
  } catch (error: unknown) {
    failure = error;
  }
  const rendered = describeOperationalCause(
    new DatabaseError({ operation: 'decode_ref', cause: failure }),
  );
  assert.equal(rendered, 'Database operation decode_ref failed: SchemaError');
  assert.ok(!rendered.includes(SENTINEL));
});
