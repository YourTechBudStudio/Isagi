import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Effect, Exit } from 'effect';
import Fastify, { type FastifyRequest } from 'fastify';

import { isWebUiDocumentRequest, registerWebUi, requireWebRoot, WebRootUnusable } from './index.js';

async function unusable(webRoot: Parameters<typeof requireWebRoot>[0]) {
  const exit = await Effect.runPromiseExit(requireWebRoot(webRoot));
  assert.ok(Exit.isFailure(exit), 'expected the web root to be refused');
  const error = exit.cause.reasons.find((reason) => reason._tag === 'Fail')?.error;
  assert.ok(error instanceof WebRootUnusable);
  return error;
}

test('a web root holding a readable index.html is accepted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-web-root-'));
  try {
    writeFileSync(join(root, 'index.html'), '<!doctype html>');
    const accepted = await Effect.runPromise(
      requireWebRoot({ value: root, source: 'flag', name: '--web-root' }),
    );
    assert.equal(accepted, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no web root names the setting and both fixes', async () => {
  const error = await unusable(undefined);
  assert.equal(
    error.message,
    'server.serveWebUi is true, but this runtime was started without a web root. Pass isagi serve --web-root <directory of a built web workbench>, or set server.serveWebUi to false.',
  );
});

test('a missing directory or index.html names the path, its source, the fs detail and the fix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-web-root-'));
  try {
    const missing = join(root, 'absent');
    const fromFlag = await unusable({ value: missing, source: 'flag', name: '--web-root' });
    assert.match(
      fromFlag.message,
      new RegExp(
        `^server\\.serveWebUi is true, but the web root ${missing} \\(from --web-root\\) has no readable index\\.html \\(ENOENT[^)]*\\)\\. Point --web-root at a built web workbench, such as apps/web/dist after building the web app, or set server\\.serveWebUi to false\\.$`,
      ),
    );

    const bundled = await unusable({ value: root, source: 'default', name: 'default' });
    assert.match(
      bundled.message,
      /the web root .+ \(the copy bundled with isagi\) has no readable index\.html \(ENOENT/,
    );

    mkdirSync(join(root, 'index.html'));
    const directory = await unusable({ value: root, source: 'flag', name: '--web-root' });
    assert.match(directory.message, /index\.html is not a file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('document requests are page GETs and HEADs outside /api and /editor/, by path segment', () => {
  const request = (method: string, url: string) => ({ method, url }) as FastifyRequest;
  for (const url of ['/', '/deep/path', '/apiary', '/editor', '/index.html?x=/api/']) {
    assert.ok(isWebUiDocumentRequest(request('GET', url)), url);
  }
  assert.ok(isWebUiDocumentRequest(request('HEAD', '/deep')));
  for (const url of ['/api', '/api?x=1', '/api/v1/nope', '/editor/1', '/editor/1/x']) {
    assert.ok(!isWebUiDocumentRequest(request('GET', url)), url);
  }
  assert.ok(!isWebUiDocumentRequest(request('POST', '/x')));
});

test('the static routes are public to the access guard, and a route registered after them is not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-web-ui-public-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  const fastify = Fastify({ logger: false });
  const seen = new Map<string, unknown>();
  fastify.addHook('onRequest', (request, _reply, done) => {
    seen.set(request.url, request.routeOptions.config.isagiPublic);
    done();
  });
  try {
    await registerWebUi(fastify, root);
    fastify.get('/api/v1/after', () => ({}));
    await fastify.inject({ method: 'GET', url: '/index.html' });
    await fastify.inject({ method: 'GET', url: '/deep/page' });
    await fastify.inject({ method: 'GET', url: '/api/v1/after' });
    assert.equal(seen.get('/index.html'), true);
    assert.equal(seen.get('/deep/page'), true);
    assert.equal(seen.get('/api/v1/after'), undefined);
  } finally {
    await fastify.close();
    rmSync(root, { recursive: true, force: true });
  }
});
