import assert from 'node:assert/strict';
import test from 'node:test';

import { Redacted } from 'effect';

import { resolveSecretReference } from './secret-reference.js';

test('a literal is used as written and an env reference reads its variable', () => {
  const literal = resolveSecretReference(Redacted.make('hunter2'), {});
  assert.equal(literal._tag === 'resolved' && Redacted.value(literal.value), 'hunter2');
  const fromEnv = resolveSecretReference(Redacted.make('env.LOGIN'), { LOGIN: 'from-shell' });
  assert.equal(fromEnv._tag === 'resolved' && Redacted.value(fromEnv.value), 'from-shell');
});

test('an unset or empty variable is named, never valued', () => {
  assert.deepEqual(resolveSecretReference(Redacted.make('env.LOGIN'), {}), {
    _tag: 'variable_unset',
    variable: 'LOGIN',
  });
  assert.deepEqual(resolveSecretReference(Redacted.make('env.LOGIN'), { LOGIN: '' }), {
    _tag: 'variable_unset',
    variable: 'LOGIN',
  });
});

test('an inherited object member is not a variable: it reads as unset', () => {
  for (const variable of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(
      resolveSecretReference(Redacted.make(`env.${variable}`), { PATH: '/usr/bin' }),
      { _tag: 'variable_unset', variable },
      variable,
    );
  }
});
