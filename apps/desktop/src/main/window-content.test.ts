import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  isAllowedWindowNavigation,
  isLoaderDocument,
  loaderBaseUrl,
  loaderUrl,
  navigationDenialCoordinate,
  pageLoadFailure,
  windowContent,
} from './window-content.js';

const base = loaderBaseUrl(resolve('/Applications/Isagi.app/dist-electron/loader/loader.html'));
const uiOrigin = 'http://127.0.0.1:47321';
const snapshot = { protocolVersion: 1, revision: 1 } as const;

test('the window shows the loader while starting, the UI once ready, and the failure page on any failure', () => {
  assert.deepEqual(windowContent({ ...snapshot, state: 'connecting' }, undefined), {
    kind: 'loader',
    loader: { state: 'starting' },
  });
  assert.deepEqual(windowContent({ ...snapshot, state: 'ready' }, undefined), { kind: 'ui' });
  assert.deepEqual(
    windowContent(
      { ...snapshot, state: 'failed', reason: 'exited_after_ready', diagnostic: { exitCode: 1 } },
      { message: 'ERR_CONNECTION_REFUSED (-102)' },
    ),
    {
      kind: 'loader',
      loader: { state: 'failed', reason: 'exited_after_ready', diagnostic: { exitCode: 1 } },
    },
    'a runtime failure outranks a page failure',
  );
  assert.deepEqual(windowContent({ ...snapshot, state: 'ready' }, { message: 'x' }), {
    kind: 'loader',
    loader: { state: 'failed', reason: 'page_load_failed', diagnostic: { message: 'x' } },
  });
  assert.deepEqual(
    windowContent({ ...snapshot, state: 'failed', reason: 'readiness_timeout' }, undefined),
    { kind: 'loader', loader: { state: 'failed', reason: 'readiness_timeout', diagnostic: {} } },
  );
});

test('the loader URL carries theme, state, reason and the diagnostic in its query', () => {
  const starting = new URL(loaderUrl(base, 'light', { state: 'starting' }));
  assert.deepEqual(Object.fromEntries(starting.searchParams), {
    theme: 'light',
    state: 'starting',
  });
  const failed = new URL(
    loaderUrl(base, 'dark', {
      state: 'failed',
      reason: 'exited_before_ready',
      diagnostic: { message: 'Runtime exited before becoming ready.', exitCode: 0, signal: null },
    }),
  );
  assert.deepEqual(Object.fromEntries(failed.searchParams), {
    theme: 'dark',
    state: 'failed',
    reason: 'exited_before_ready',
    message: 'Runtime exited before becoming ready.',
    exitCode: '0',
  });
  assert.ok(isLoaderDocument(failed.href, base));
});

test('navigation is allowed only to the loader and the UI origin', () => {
  const allowed = (url: string) =>
    isAllowedWindowNavigation({ url, loaderBaseUrl: base, uiOrigin });
  assert.ok(allowed(`${base}?state=failed#x`));
  assert.ok(allowed(`${uiOrigin}/`));
  assert.ok(allowed(`${uiOrigin}/deep/path?x=1`));
  for (const url of [
    'http://127.0.0.1:47322/',
    'https://127.0.0.1:47321/',
    'http://localhost:47321/',
    'https://example.test/',
    'file:///etc/passwd',
    `${base.replace('loader.html', 'other.html')}`,
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.equal(allowed(url), false, url);
  }
});

test('a page load failure counts only for the UI main frame and never for an aborted load', () => {
  const event = {
    errorCode: -102,
    errorDescription: 'ERR_CONNECTION_REFUSED',
    url: `${uiOrigin}/x?q=secret`,
    isMainFrame: true,
    uiOrigin,
  };
  assert.deepEqual(pageLoadFailure(event), {
    message: `ERR_CONNECTION_REFUSED (-102) · ${uiOrigin}`,
  });
  assert.equal(pageLoadFailure({ ...event, errorCode: -3 }), undefined);
  assert.equal(pageLoadFailure({ ...event, isMainFrame: false }), undefined);
  assert.equal(pageLoadFailure({ ...event, url: base }), undefined);
});

test('a denial coordinate never carries the URL beyond its origin or scheme', () => {
  assert.equal(
    navigationDenialCoordinate('https://example.test:8443/path?token=secret#frag'),
    'https://example.test:8443',
  );
  assert.equal(
    navigationDenialCoordinate('http://user:secret@example.test/'),
    'http://example.test',
  );
  assert.equal(navigationDenialCoordinate('javascript:alert(document.cookie)'), 'javascript:');
  assert.equal(navigationDenialCoordinate(`${base}?message=/Users/ada/secret`), 'file:');
  assert.equal(navigationDenialCoordinate('not a url'), 'an unparseable URL');
});
