import assert from 'node:assert/strict';
import test from 'node:test';

import { Either, Schema } from 'effect';

import { commandRunDiagnosticReasonSchema, commandSummarySchema } from '@isagi/contracts';

/**
 * The wire guard for the resolved-port break.
 *
 * `ports` used to be a bare list of port numbers. Reintroducing that union
 * anywhere in the contract would silently re-admit the old shape while every
 * positive test stayed green, so the rejection is pinned here directly against
 * the decoder the API boundary uses.
 */

const decode = Schema.decodeUnknownEither(commandSummarySchema);

test('the legacy numeric port summary is rejected at the contract boundary', () => {
  assert.ok(Either.isLeft(decode({ name: 'dev', status: 'running', ports: [5173] })));
});

test('a structured port summary decodes at the contract boundary', () => {
  const decoded = decode({
    name: 'dev',
    status: 'running',
    ports: [
      {
        port: 5173,
        envVar: null,
        urls: [{ label: 'app', path: '/', url: 'http://localhost:5173/' }],
      },
    ],
  });

  assert.ok(Either.isRight(decoded));
});

test('a null port summary decodes as honest unknown degradation', () => {
  assert.ok(Either.isRight(decode({ name: 'dev', status: 'running', ports: null })));
});

test('the allocation-failure reason crosses the diagnostic contract boundary', () => {
  // The runtime writes this literal and the web indexes its copy map by it, so a
  // typo either side is a silent blank notice rather than a type error at the
  // point of use. Pinning the exact string here is what makes the two ends one
  // contract.
  const decodeReason = Schema.decodeUnknownEither(commandRunDiagnosticReasonSchema);

  assert.deepEqual(decodeReason('port_allocation_failed'), Either.right('port_allocation_failed'));
  assert.ok(Either.isLeft(decodeReason('port_allocation_failure')));
});
