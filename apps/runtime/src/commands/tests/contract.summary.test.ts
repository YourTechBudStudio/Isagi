import assert from 'node:assert/strict';
import test from 'node:test';

import { Either, Schema } from 'effect';

import { commandSummarySchema } from '@isagi/contracts';

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
