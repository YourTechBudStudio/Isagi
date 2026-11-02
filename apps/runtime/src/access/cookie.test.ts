import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearedSessionSetCookie,
  readCookie,
  sessionSetCookie,
  stripSessionCookie,
} from './cookie.js';

test('readCookie finds the first value of one named cookie', () => {
  assert.equal(readCookie('a=1; isagi_session=v1.2.x; b=3', 'isagi_session'), 'v1.2.x');
  assert.equal(readCookie('isagi_session=first; isagi_session=second', 'isagi_session'), 'first');
  assert.equal(readCookie('xisagi_session=no; b=3', 'isagi_session'), undefined);
  assert.equal(readCookie('flag; isagi_session=yes', 'isagi_session'), 'yes');
  assert.equal(readCookie(undefined, 'isagi_session'), undefined);
});

test('stripSessionCookie removes only the login cookie and drops an empty header', () => {
  assert.equal(stripSessionCookie('a=1; isagi_session=v1.2.x; b=3'), 'a=1; b=3');
  assert.equal(stripSessionCookie('isagi_session=v1.2.x'), undefined);
  assert.equal(stripSessionCookie('isagi_session=a;isagi_session=b'), undefined);
  assert.equal(stripSessionCookie('vscode-tkn=abc'), 'vscode-tkn=abc');
  assert.equal(stripSessionCookie('xisagi_session=keep'), 'xisagi_session=keep');
});

test('the login cookie is persistent for a week, HttpOnly, SameSite=Lax and never Secure', () => {
  assert.equal(
    sessionSetCookie('v1.2.x'),
    'isagi_session=v1.2.x; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
  );
  assert.equal(
    clearedSessionSetCookie,
    'isagi_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
  );
});
