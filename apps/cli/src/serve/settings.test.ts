import assert from 'node:assert/strict';
import test from 'node:test';

import { Option } from 'effect';

import { resolveServeLaunch, type ServeFlags } from './settings.js';

const none: ServeFlags = {
  host: Option.none(),
  port: Option.none(),
  dataDir: Option.none(),
  webRoot: Option.none(),
  allowedOrigins: Option.none(),
};
const where = { cwd: '/work/here', home: '/home/me' };

function resolve(
  flags: Partial<Record<keyof ServeFlags, string>>,
  env: Record<string, string> = {},
  bundled: { readonly webRoot: string | undefined } = { webRoot: undefined },
) {
  const given: ServeFlags = {
    ...none,
    ...Object.fromEntries(Object.entries(flags).map(([key, value]) => [key, Option.some(value)])),
  };
  return resolveServeLaunch(given, { ...where, env }, bundled);
}

function settingsOf(result: ReturnType<typeof resolve>) {
  assert.ok(result.ok, result.ok ? '' : result.failure.document.message);
  return result.settings;
}

function failureOf(result: ReturnType<typeof resolve>) {
  assert.ok(!result.ok, 'expected a failure');
  return result.failure.document;
}

test('nothing set: host and port are the runtime’s to resolve, data in ~/.isagi', () => {
  assert.deepEqual(settingsOf(resolve({})), {
    host: undefined,
    port: undefined,
    dataDirectory: { value: '/home/me/.isagi', source: 'default', name: 'default' },
    webRoot: undefined,
    allowedOrigins: [],
  });
});

test('a flag beats its environment variable, and each value names its source', () => {
  const env = { ISAGI_HOST: '0.0.0.0', ISAGI_PORT: '8080', ISAGI_DATA_DIR: '/srv/isagi' };
  assert.deepEqual(settingsOf(resolve({}, env)), {
    host: { value: '0.0.0.0', source: 'env', name: 'ISAGI_HOST' },
    port: { value: 8080, source: 'env', name: 'ISAGI_PORT' },
    dataDirectory: { value: '/srv/isagi', source: 'env', name: 'ISAGI_DATA_DIR' },
    webRoot: undefined,
    allowedOrigins: [],
  });
  const flagged = settingsOf(resolve({ host: '127.0.0.1', port: '11299', dataDir: '/data' }, env));
  assert.deepEqual(flagged.host, { value: '127.0.0.1', source: 'flag', name: '--host' });
  assert.deepEqual(flagged.port, { value: 11299, source: 'flag', name: '--port' });
  assert.deepEqual(flagged.dataDirectory, { value: '/data', source: 'flag', name: '--data-dir' });
});

test('an empty environment variable counts as unset', () => {
  const settings = settingsOf(resolve({}, { ISAGI_HOST: '', ISAGI_PORT: '', ISAGI_DATA_DIR: '' }));
  assert.equal(settings.host, undefined);
  assert.equal(settings.port, undefined);
  assert.equal(settings.dataDirectory.source, 'default');
});

test('ports are decimal digits from 0 to 65535', () => {
  assert.equal(settingsOf(resolve({ port: '0' })).port?.value, 0);
  assert.equal(settingsOf(resolve({ port: '65535' })).port?.value, 65535);
  for (const port of ['65536', '80a', '8080abc', '-1', '1.5', ' 80', '']) {
    assert.equal(failureOf(resolve({ port })).code, 'cli_usage_invalid', port);
  }
});

test('an invalid value fails with its source and never falls through to a lower tier', () => {
  assert.deepEqual(failureOf(resolve({}, { ISAGI_PORT: '80a' })), {
    code: 'cli_usage_invalid',
    message: 'ISAGI_PORT must be a whole number from 0 to 65535, got "80a".',
    recovery: 'Set ISAGI_PORT to a whole number from 0 to 65535, or pass --port.',
    context: { port: { value: '80a', source: 'env', name: 'ISAGI_PORT' } },
  });
  assert.deepEqual(failureOf(resolve({ port: '70000' }, { ISAGI_PORT: '8080' })), {
    code: 'cli_usage_invalid',
    message: '--port must be a whole number from 0 to 65535, got "70000".',
    recovery: 'Pass --port a whole number from 0 to 65535.',
    context: { port: { value: '70000', source: 'flag', name: '--port' } },
  });
  assert.deepEqual(failureOf(resolve({ host: '' }, { ISAGI_HOST: '0.0.0.0' })).context, {
    host: { value: '', source: 'flag', name: '--host' },
  });
  assert.deepEqual(failureOf(resolve({ dataDir: '' })).context, {
    dataDirectory: { value: '', source: 'flag', name: '--data-dir' },
  });
  assert.deepEqual(failureOf(resolve({ webRoot: '' })).context, {
    webRoot: { value: '', source: 'flag', name: '--web-root' },
  });
});

test('paths expand ~ and resolve against the current directory', () => {
  assert.equal(settingsOf(resolve({ dataDir: '~' })).dataDirectory.value, '/home/me');
  assert.equal(
    settingsOf(resolve({ dataDir: '~/isagi-server' })).dataDirectory.value,
    '/home/me/isagi-server',
  );
  assert.equal(settingsOf(resolve({ dataDir: 'data' })).dataDirectory.value, '/work/here/data');
  assert.equal(settingsOf(resolve({}, { ISAGI_DATA_DIR: '../d' })).dataDirectory.value, '/work/d');
  assert.deepEqual(settingsOf(resolve({ webRoot: 'web' })).webRoot, {
    value: '/work/here/web',
    source: 'flag',
    name: '--web-root',
  });
});

test('the web root is the flag, else the bundled copy, else none', () => {
  const bundled = { webRoot: '/pkg/web' };
  assert.deepEqual(settingsOf(resolve({ webRoot: '/srv/web' }, {}, bundled)).webRoot, {
    value: '/srv/web',
    source: 'flag',
    name: '--web-root',
  });
  assert.deepEqual(settingsOf(resolve({}, {}, bundled)).webRoot, {
    value: '/pkg/web',
    source: 'default',
    name: 'default',
  });
  assert.equal(settingsOf(resolve({})).webRoot, undefined);
  assert.deepEqual(failureOf(resolve({ webRoot: '' }, {}, bundled)).context, {
    webRoot: { value: '', source: 'flag', name: '--web-root' },
  });
});

test('allowed origins are trimmed, empties dropped, and each must be an origin or file://', () => {
  assert.deepEqual(
    settingsOf(resolve({ allowedOrigins: ' http://localhost:5173, ,file://,https://isagi.dev ' }))
      .allowedOrigins,
    ['http://localhost:5173', 'file://', 'https://isagi.dev'],
  );
  assert.deepEqual(settingsOf(resolve({ allowedOrigins: '' })).allowedOrigins, []);
  for (const origins of [
    'http://localhost:5173/',
    'http://localhost:5173/app',
    'localhost:5173',
    'ftp://host',
    'file:///tmp',
    'http://localhost:5173,nope',
  ]) {
    const failure = failureOf(resolve({ allowedOrigins: origins }));
    assert.deepEqual(failure.context, {
      allowedOrigins: { value: origins, source: 'flag', name: '--allowed-origins' },
    });
  }
});
