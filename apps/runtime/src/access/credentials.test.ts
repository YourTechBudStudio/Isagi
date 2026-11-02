import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { Redacted } from 'effect';

import {
  bearerToken,
  sameSecret,
  sessionMaxAgeSeconds,
  sessionRenewAfterSeconds,
  signSession,
  verifySession,
} from './credentials.js';

const secret = Redacted.make('signing-secret');
const now = 1_800_000_000;

test('a signed session is v1, its issue time and a MAC, and verifies under the same secret', () => {
  const value = signSession(secret, now);
  assert.match(value, /^v1\.1800000000\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(verifySession(secret, value, now), { _tag: 'valid', renew: false });
});

test('a session signed with another secret, or with a tampered issue time or MAC, is invalid', () => {
  const value = signSession(secret, now);
  assert.deepEqual(verifySession(Redacted.make('rotated'), value, now), { _tag: 'invalid' });
  const [, , mac] = value.split('.');
  assert.deepEqual(verifySession(secret, `v1.${now + 1}.${mac}`, now + 1), { _tag: 'invalid' });
  assert.deepEqual(verifySession(secret, `v1.${now}.${mac!.slice(0, -2)}AA`, now), {
    _tag: 'invalid',
  });
  assert.deepEqual(verifySession(secret, `v1.${now}.${mac!.slice(0, 20)}`, now), {
    _tag: 'invalid',
  });
  for (const garbage of ['', 'v1', `v2.${now}.${mac}`, `v1.abc.${mac}`, 'v1..', `v1.${now}.`]) {
    assert.deepEqual(verifySession(secret, garbage, now), { _tag: 'invalid' }, garbage);
  }
});

test('a session expires after a week and is renewed only once older than a day', () => {
  const value = signSession(secret, now);
  assert.deepEqual(verifySession(secret, value, now + sessionRenewAfterSeconds), {
    _tag: 'valid',
    renew: false,
  });
  assert.deepEqual(verifySession(secret, value, now + sessionRenewAfterSeconds + 1), {
    _tag: 'valid',
    renew: true,
  });
  assert.deepEqual(verifySession(secret, value, now + sessionMaxAgeSeconds - 1), {
    _tag: 'valid',
    renew: true,
  });
  assert.deepEqual(verifySession(secret, value, now + sessionMaxAgeSeconds), { _tag: 'invalid' });
});

test('an issue time more than a minute in the future is invalid', () => {
  assert.equal(verifySession(secret, signSession(secret, now + 60), now)._tag, 'valid');
  assert.equal(verifySession(secret, signSession(secret, now + 61), now)._tag, 'invalid');
});

test('bearerToken reads only a non-empty Bearer token', () => {
  assert.equal(bearerToken('Bearer abc123'), 'abc123');
  assert.equal(bearerToken('bearer abc123'), 'abc123');
  assert.equal(bearerToken('Bearer '), undefined);
  assert.equal(bearerToken('Bearer'), undefined);
  assert.equal(bearerToken('Basic YWxhZGRpbjpvcGVu'), undefined);
  assert.equal(bearerToken('Bearer a b'), undefined);
  assert.equal(bearerToken(undefined), undefined);
});

test('sameSecret compares strings of any length, including empty ones', () => {
  const key = randomBytes(32);
  assert.equal(sameSecret(key, 'hunter2', 'hunter2'), true);
  assert.equal(sameSecret(key, 'hunter2', 'hunter3'), false);
  assert.equal(sameSecret(key, 'short', 'a much longer value than short'), false);
  assert.equal(sameSecret(key, '', ''), true);
  assert.equal(sameSecret(key, '', 'x'), false);
});
