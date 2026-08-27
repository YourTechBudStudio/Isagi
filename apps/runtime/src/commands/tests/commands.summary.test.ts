import assert from 'node:assert/strict';
import test from 'node:test';

import type { CommandStatus } from '@isagi/contracts';

import { buildCommandSummary, composeCommandPortUrl } from '../commands.summary.js';

/**
 * The whole resolved-port projection, in one table.
 *
 * Every summary the runtime emits goes through this builder, so these three
 * cases are the complete contract every caller inherits — there is no second
 * place where the running gate or the null-versus-empty boundary is decided.
 */

const entries = [
  {
    envVar: 'API_PORT',
    port: 5173,
    paths: [
      { label: 'app', path: '/' },
      { label: 'docs', path: '/docs' },
    ],
  },
  { envVar: null, port: 9229, paths: [] },
];

test('a running command with a snapshot reports its resolved ports and composed URLs', () => {
  assert.deepEqual(
    buildCommandSummary({ name: 'dev', status: 'running', resolvedPorts: entries }),
    {
      name: 'dev',
      status: 'running',
      ports: [
        {
          port: 5173,
          envVar: 'API_PORT',
          urls: [
            { label: 'app', path: '/', url: 'http://localhost:5173/' },
            { label: 'docs', path: '/docs', url: 'http://localhost:5173/docs' },
          ],
        },
        // A pathless port still resolves and is still reported; it simply has no
        // URL to offer.
        { port: 9229, envVar: null, urls: [] },
      ],
    },
  );
});

test('a running command with no snapshot reports unknown, not empty', () => {
  // The distinction the whole nullable field exists for: "I do not know what
  // this incarnation got" is not the same claim as "it declared no ports".
  assert.equal(
    buildCommandSummary({ name: 'dev', status: 'running', resolvedPorts: null }).ports,
    null,
  );
});

test('a running command that declared no ports reports an empty list', () => {
  assert.deepEqual(
    buildCommandSummary({ name: 'dev', status: 'running', resolvedPorts: [] }).ports,
    [],
  );
});

test('a command that is not running reports no ports whatever it remembers', () => {
  const statuses: readonly CommandStatus[] = ['idle', 'exited', 'stopped', 'failed', 'suspended'];
  for (const status of statuses) {
    assert.deepEqual(
      buildCommandSummary({ name: 'dev', status, resolvedPorts: entries }).ports,
      [],
      `${status} must not expose resolved ports`,
    );
    assert.deepEqual(buildCommandSummary({ name: 'dev', status, resolvedPorts: null }).ports, []);
  }
});

test('the root path composes without a doubled slash', () => {
  assert.equal(composeCommandPortUrl(5173, '/'), 'http://localhost:5173/');
  assert.equal(composeCommandPortUrl(5173, '/docs'), 'http://localhost:5173/docs');
});
