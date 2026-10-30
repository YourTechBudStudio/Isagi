import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeSource,
  localRuntimeUrl,
  resolveListenSettings,
  RuntimeListenFailed,
} from './listen.js';

const noLaunch = { host: undefined, port: undefined };

test('nothing set listens on loopback and any free port', () => {
  assert.deepEqual(resolveListenSettings(noLaunch, {}), {
    host: { value: '127.0.0.1', source: 'default', name: 'default' },
    port: { value: 0, source: 'default', name: 'default' },
  });
});

test('config.yaml beats the default', () => {
  assert.deepEqual(resolveListenSettings(noLaunch, { host: '0.0.0.0', port: 11_299 }), {
    host: { value: '0.0.0.0', source: 'config', name: 'server.host' },
    port: { value: 11_299, source: 'config', name: 'server.port' },
  });
});

test('the launch (flag or environment) beats config.yaml, per setting', () => {
  const settings = resolveListenSettings(
    { host: undefined, port: { value: 8080, source: 'env', name: 'ISAGI_PORT' } },
    { host: '0.0.0.0', port: 11_299 },
  );
  assert.deepEqual(settings, {
    host: { value: '0.0.0.0', source: 'config', name: 'server.host' },
    port: { value: 8080, source: 'env', name: 'ISAGI_PORT' },
  });
  const flagged = resolveListenSettings(
    {
      host: { value: '127.0.0.1', source: 'flag', name: '--host' },
      port: { value: 0, source: 'flag', name: '--port' },
    },
    { host: '0.0.0.0', port: 11_299 },
  );
  assert.deepEqual(flagged.host.source, 'flag');
  assert.deepEqual(flagged.port, { value: 0, source: 'flag', name: '--port' });
});

test('a wildcard bind reports loopback; other addresses are reported as bound', () => {
  assert.equal(
    localRuntimeUrl({ address: '0.0.0.0', family: 'IPv4', port: 4100 }),
    'http://127.0.0.1:4100',
  );
  assert.equal(
    localRuntimeUrl({ address: '::', family: 'IPv6', port: 4100 }),
    'http://127.0.0.1:4100',
  );
  assert.equal(
    localRuntimeUrl({ address: '127.0.0.1', family: 'IPv4', port: 4100 }),
    'http://127.0.0.1:4100',
  );
  assert.equal(
    localRuntimeUrl({ address: '192.168.1.20', family: 'IPv4', port: 80 }),
    'http://192.168.1.20:80',
  );
  assert.equal(
    localRuntimeUrl({ address: '::1', family: 'IPv6', port: 4100 }),
    'http://[::1]:4100',
  );
});

test('sources are described as the user wrote them', () => {
  assert.equal(describeSource({ value: 1, source: 'flag', name: '--port' }), '--port');
  assert.equal(describeSource({ value: 1, source: 'env', name: 'ISAGI_PORT' }), 'ISAGI_PORT');
  assert.equal(
    describeSource({ value: 1, source: 'config', name: 'server.port' }),
    'config.yaml server.port',
  );
  assert.equal(describeSource({ value: 1, source: 'default', name: 'default' }), 'default');
});

test('a listen failure names both values and their sources', () => {
  const failure = new RuntimeListenFailed({
    host: { value: '127.0.0.1', source: 'default', name: 'default' },
    port: { value: 11_299, source: 'config', name: 'server.port' },
    cause: new Error('listen EADDRINUSE: address already in use 127.0.0.1:11299'),
  });
  assert.equal(
    failure.message,
    'Could not listen on 127.0.0.1:11299 (host from default, port from config.yaml server.port): listen EADDRINUSE: address already in use 127.0.0.1:11299',
  );
  const ipv6 = new RuntimeListenFailed({
    host: { value: '::1', source: 'flag', name: '--host' },
    port: { value: 80, source: 'env', name: 'ISAGI_PORT' },
    cause: new Error('listen EACCES'),
  });
  assert.equal(
    ipv6.message,
    'Could not listen on [::1]:80 (host from --host, port from ISAGI_PORT): listen EACCES',
  );
});
