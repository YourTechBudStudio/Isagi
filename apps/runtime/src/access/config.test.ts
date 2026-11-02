import assert from 'node:assert/strict';
import test from 'node:test';

import { Redacted, Result } from 'effect';

import { AccessConfigInvalid, resolveAuthMode } from './config.js';

const literal = (value: string) => Redacted.make(value);

test('login off resolves to disabled without checking any field', () => {
  assert.deepEqual(resolveAuthMode({ enabled: false }, {}), Result.succeed({ _tag: 'disabled' }));
  assert.deepEqual(
    resolveAuthMode({ enabled: false, password: literal('env.UNSET'), username: literal('') }, {}),
    Result.succeed({ _tag: 'disabled' }),
  );
});

test('login on resolves literals and env references', () => {
  const result = resolveAuthMode(
    {
      enabled: true,
      username: literal('ada'),
      password: literal('env.LOGIN_PASSWORD'),
      signingSecret: literal('s3cret'),
    },
    { LOGIN_PASSWORD: 'from-shell' },
  );
  assert.ok(Result.isSuccess(result) && result.success._tag === 'enabled');
  const mode = result.success;
  assert.equal(Redacted.value(mode.username), 'ada');
  assert.equal(Redacted.value(mode.password), 'from-shell');
  assert.equal(Redacted.value(mode.signingSecret), 's3cret');
});

test('every problem is collected by path and variable, and the message holds no value', () => {
  const result = resolveAuthMode(
    {
      enabled: true,
      username: literal(''),
      password: literal('env.LOGIN_PASSWORD'),
      signingSecret: literal('env.ISAGI_SECRET'),
    },
    // An ISAGI_* variable is stripped from the login-shell environment before resolution, so it is never here.
    { LOGIN_PASSWORD: '' },
  );
  assert.ok(Result.isFailure(result));
  const error = result.failure;
  assert.ok(error instanceof AccessConfigInvalid);
  assert.deepEqual(error.problems, [
    { path: 'server.auth.username', problem: 'missing' },
    { path: 'server.auth.password', problem: 'variable_unset', variable: 'LOGIN_PASSWORD' },
    { path: 'server.auth.signingSecret', problem: 'variable_unset', variable: 'ISAGI_SECRET' },
  ]);
  assert.equal(
    error.message,
    'server.auth is enabled but server.auth.username is missing or empty; server.auth.password names env.LOGIN_PASSWORD, which is unset or empty in the login shell environment; server.auth.signingSecret names env.ISAGI_SECRET, which is unset or empty in the login shell environment. Set them in config.yaml, then restart.',
  );
});

test('each missing field is named on its own', () => {
  for (const field of ['username', 'password', 'signingSecret'] as const) {
    const settings = {
      enabled: true,
      username: literal('u-value'),
      password: literal('p-value'),
      signingSecret: literal('s-value'),
    };
    delete (settings as Partial<typeof settings>)[field];
    const result = resolveAuthMode(settings, {});
    assert.ok(Result.isFailure(result), field);
    assert.deepEqual(result.failure.problems, [
      { path: `server.auth.${field}`, problem: 'missing' },
    ]);
    for (const value of ['u-value', 'p-value', 's-value']) {
      assert.ok(!result.failure.message.includes(value), field);
    }
  }
});

test('an env reference naming an inherited object member fails startup as an unset variable', () => {
  const result = resolveAuthMode(
    {
      enabled: true,
      username: literal('ada'),
      password: literal('pw'),
      signingSecret: literal('env.constructor'),
    },
    { PATH: '/usr/bin' },
  );
  assert.ok(Result.isFailure(result));
  assert.deepEqual(result.failure.problems, [
    { path: 'server.auth.signingSecret', problem: 'variable_unset', variable: 'constructor' },
  ]);
  assert.equal(
    result.failure.message,
    'server.auth is enabled but server.auth.signingSecret names env.constructor, which is unset or empty in the login shell environment. Set them in config.yaml, then restart.',
  );
});
