import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';

import {
  enforceRuntimeWebSocketOrigin,
  installAllowedOrigins,
  isAllowedRuntimeOrigin,
} from './origin.js';

test('allows only exact configured browser origins', () => {
  const allowed = new Set(['http://127.0.0.1:43129', 'https://runtime-ui.example.test']);
  assert.equal(isAllowedRuntimeOrigin('http://127.0.0.1:43129', allowed), true);
  assert.equal(isAllowedRuntimeOrigin('https://runtime-ui.example.test', allowed), true);
  assert.equal(isAllowedRuntimeOrigin('http://127.0.0.1:43130', allowed), false);
  assert.equal(isAllowedRuntimeOrigin('http://localhost:43129', allowed), false);
  assert.equal(isAllowedRuntimeOrigin('http://127.0.0.1:5173', allowed), false);
});

test('allows absent and null origins for local non-browser and opaque clients', () => {
  assert.equal(isAllowedRuntimeOrigin(undefined, new Set()), true);
  assert.equal(isAllowedRuntimeOrigin('null', new Set()), true);
});

test('allows the packaged file renderer only when it is explicitly configured', () => {
  assert.equal(isAllowedRuntimeOrigin('file://', new Set()), false);
  const allowed = new Set(['file://']);
  assert.equal(isAllowedRuntimeOrigin('file://', allowed), true);
  assert.equal(isAllowedRuntimeOrigin('file:///Applications/Isagi.app', allowed), false);
});

test('the WebSocket guard reads the set installed on the serving instance, inherited by plugins', async () => {
  const fastify = Fastify({ logger: false });
  installAllowedOrigins(fastify, ['http://allowed.test']);
  await fastify.register(async (scoped) => {
    scoped.get('/guarded', { preValidation: enforceRuntimeWebSocketOrigin }, () => 'ok');
  });
  const other = Fastify({ logger: false });
  other.get('/guarded', { preValidation: enforceRuntimeWebSocketOrigin }, () => 'ok');
  try {
    const allowed = await fastify.inject({
      url: '/guarded',
      headers: { origin: 'http://allowed.test' },
    });
    assert.equal(allowed.statusCode, 200);
    const refused = await fastify.inject({
      url: '/guarded',
      headers: { origin: 'http://other.test' },
    });
    assert.equal(refused.statusCode, 403);
    // An instance with nothing installed accepts no browser origin.
    const uninstalled = await other.inject({
      url: '/guarded',
      headers: { origin: 'http://allowed.test' },
    });
    assert.equal(uninstalled.statusCode, 403);
  } finally {
    await fastify.close();
    await other.close();
  }
});
