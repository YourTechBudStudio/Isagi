import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { developmentPaths } from '../../../../scripts/dev-supervisor/dev-protocol.mjs';
import {
  resolveDesktopDataDirectory,
  resolveDesktopMode,
  unpackagedUserDataDirectory,
} from './desktop-mode.js';

const root = resolve('/checkout');
const home = resolve('/home/ada');
const developmentRoot = () => root;

test('ISAGI_WEB_URL is the only switch into development, and never applies to a packaged app', () => {
  assert.deepEqual(resolveDesktopMode({ isPackaged: true, webUrl: 'http://127.0.0.1:5173' }), {
    kind: 'packaged',
  });
  assert.deepEqual(resolveDesktopMode({ isPackaged: false, webUrl: undefined }), {
    kind: 'unpackaged',
  });
  assert.deepEqual(resolveDesktopMode({ isPackaged: false, webUrl: '' }), { kind: 'unpackaged' });
  assert.deepEqual(resolveDesktopMode({ isPackaged: false, webUrl: 'http://127.0.0.1:5173' }), {
    kind: 'development',
    webUrl: 'http://127.0.0.1:5173',
  });
});

test('packaged: ISAGI_DATA_DIR, else ~/.isagi', () => {
  const mode = { kind: 'packaged' } as const;
  assert.equal(
    resolveDesktopDataDirectory({ mode, env: {}, developmentRoot, home }),
    join(home, '.isagi'),
  );
  assert.equal(
    resolveDesktopDataDirectory({
      mode,
      env: { ISAGI_DATA_DIR: '~/isagi-b' },
      developmentRoot,
      home,
    }),
    join(home, 'isagi-b'),
  );
});

test('unpackaged: ISAGI_DATA_DIR, else the checkout data root', () => {
  const mode = { kind: 'unpackaged' } as const;
  assert.equal(
    resolveDesktopDataDirectory({ mode, env: {}, developmentRoot, home }),
    developmentPaths(root).dataRoot,
  );
  assert.equal(
    resolveDesktopDataDirectory({
      mode,
      env: { ISAGI_DATA_DIR: '/tmp/e2e-1' },
      developmentRoot,
      home,
    }),
    resolve('/tmp/e2e-1'),
  );
});

test('development ignores an inherited ISAGI_DATA_DIR', () => {
  const mode = { kind: 'development', webUrl: 'http://127.0.0.1:5173' } as const;
  assert.equal(
    resolveDesktopDataDirectory({
      mode,
      env: { ISAGI_DATA_DIR: join(home, '.isagi') },
      developmentRoot,
      home,
    }),
    developmentPaths(root).dataRoot,
  );
});

test('the unpackaged profile sits beside its data, matching the development layout', () => {
  assert.equal(
    unpackagedUserDataDirectory(developmentPaths(root).dataRoot),
    developmentPaths(root).userData,
  );
});
