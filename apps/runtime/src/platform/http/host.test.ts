import assert from 'node:assert/strict';
import { connect } from 'node:net';
import test from 'node:test';

import Fastify from 'fastify';

import { hostnameFromHostHeader, installHostGuard, isLoopbackHostname } from './host.js';

test('a Host header parses strictly to its lowercased hostname, ignoring the port', () => {
  assert.equal(hostnameFromHostHeader('LocalHost:80'), 'localhost');
  assert.equal(hostnameFromHostHeader('vm.Tail.ts.net'), 'vm.tail.ts.net');
  assert.equal(hostnameFromHostHeader('127.0.0.5:11299'), '127.0.0.5');
  assert.equal(hostnameFromHostHeader('[::1]:80'), '::1');
  assert.equal(hostnameFromHostHeader('[FD7A::1]'), 'fd7a::1');
  for (const malformed of [
    undefined,
    '',
    'a@127.0.0.1',
    'host:',
    'host:80x',
    '[::1',
    '[not-ip]:80',
    'http://localhost',
    'local host',
  ]) {
    assert.equal(hostnameFromHostHeader(malformed), null, String(malformed));
  }
});

test('loopback is localhost, *.localhost, 127.0.0.0/8 and ::1 only', () => {
  for (const loopback of ['localhost', 'a.localhost', '127.0.0.1', '127.0.0.5', '::1']) {
    assert.equal(isLoopbackHostname(loopback), true, loopback);
  }
  for (const other of [
    '0.0.0.0',
    '::',
    '::ffff:127.0.0.1',
    '127.example.test',
    'localhost.evil.test',
  ]) {
    assert.equal(isLoopbackHostname(other), false, other);
  }
});

/** The status the guard answers for `host` under `allowedHosts`: 200 admitted, 403 refused. */
// `inject` replaces an empty Host with `localhost:80`, so the empty case is covered by the parser test only.
async function statusFor(allowedHosts: readonly string[], host: string) {
  const fastify = Fastify({ logger: false });
  installHostGuard(fastify, allowedHosts);
  fastify.get('/', () => 'ok');
  try {
    const response = await fastify.inject({ method: 'GET', url: '/', headers: { host } });
    return response.statusCode;
  } finally {
    await fastify.close();
  }
}

test('the guard admits loopback with nothing listed and refuses every other host', async () => {
  for (const host of ['localhost', '127.0.0.1:4000', '[::1]:80', 'a.localhost']) {
    assert.equal(await statusFor([], host), 200, host);
  }
  for (const host of ['evil.test', '0.0.0.0', '192.168.1.20:4000', 'a@127.0.0.1']) {
    assert.equal(await statusFor([], host), 403, host);
  }
});

test('the guard admits exact entries and leading wildcards, never the bare domain or an IP', async () => {
  const listed = ['vm.example.test', '*.tail.ts.net', '192.168.1.20', 'fd7a::1'];
  for (const host of [
    'vm.example.test',
    'VM.example.test:443',
    'vm.tail.ts.net',
    'a.b.tail.ts.net',
    '192.168.1.20:11299',
    '[fd7a::1]:80',
  ]) {
    assert.equal(await statusFor(listed, host), 200, host);
  }
  for (const host of ['tail.ts.net', 'eviltail.ts.net', 'other.example.test', '192.168.1.21']) {
    assert.equal(await statusFor(listed, host), 403, host);
  }
  // A suffix never admits an IP literal, even one that textually ends with it.
  assert.equal(await statusFor(['*.1.20'], '192.168.1.20'), 403);
});

test('a bare * admits every well-formed host and still refuses a malformed one', async () => {
  for (const host of ['anything.test', '203.0.113.9:80', '[2001:db8::1]']) {
    assert.equal(await statusFor(['*'], host), 200, host);
  }
  for (const host of ['a@127.0.0.1', 'bad host']) {
    assert.equal(await statusFor(['*'], host), 403, host);
  }
});

test('a refusal is the api_host_not_allowed envelope carrying the raw Host', async () => {
  const fastify = Fastify({ logger: false });
  installHostGuard(fastify, []);
  fastify.get('/', () => 'ok');
  try {
    const response = await fastify.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'Evil.test:8080' },
    });
    assert.equal(response.statusCode, 403);
    const { error } = response.json<{
      error: { code: string; message: string; data: { host: string | null } };
    }>();
    assert.equal(error.code, 'api_host_not_allowed');
    assert.deepEqual(error.data, { host: 'Evil.test:8080' });
    assert.match(error.message, /"evil\.test"/);
    assert.match(error.message, /server\.allowedHosts/);
  } finally {
    await fastify.close();
  }
});

test('a request with no Host at all is refused, even under *', async () => {
  const fastify = Fastify({ logger: false });
  installHostGuard(fastify, ['*']);
  fastify.get('/', () => 'ok');
  try {
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const { port } = fastify.server.address() as { port: number };
    // `inject` always fills in a Host, and HTTP/1.1 clients always send one, so speak HTTP/1.0 directly.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.end('GET / HTTP/1.0\r\n\r\n'));
      let received = '';
      socket.on('data', (chunk) => (received += chunk.toString()));
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.[01] 403/);
    const body = JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4)) as {
      error: { code: string; message: string; data: { host: string | null } };
    };
    assert.equal(body.error.code, 'api_host_not_allowed');
    assert.deepEqual(body.error.data, { host: null });
    assert.match(body.error.message, /"\(none\)"/);
  } finally {
    await fastify.close();
  }
});
