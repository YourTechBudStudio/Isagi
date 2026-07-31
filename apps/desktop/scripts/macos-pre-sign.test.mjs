import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyMacosPreSign } from './macos-pre-sign.mjs';

test('pre-sign hook verifies the packaged runtime at the Builder afterPack boundary', () => {
  const calls = [];
  const result = verifyMacosPreSign(
    { appOutDir: '/tmp/output/mac-arm64', electronPlatformName: 'darwin' },
    {
      sourceRoot: '/tmp/canonical-runtime',
      verify: (...args) => {
        calls.push(args);
        return { byteFileCount: 10, executableFileCount: 1 };
      },
    },
  );
  assert.deepEqual(calls, [
    [
      '/tmp/canonical-runtime',
      '/tmp/output/mac-arm64/Isagi.app/Contents/Resources/runtime',
      'darwin',
    ],
  ]);
  assert.equal(result.byteFileCount, 10);
});

test('pre-sign parity failures escape the hook and abort packaging', () => {
  const failure = new Error('staged bytes differ');
  assert.throws(
    () =>
      verifyMacosPreSign(
        { appOutDir: '/tmp/output/mac', electronPlatformName: 'darwin' },
        {
          sourceRoot: '/tmp/stage',
          verify: () => {
            throw failure;
          },
        },
      ),
    (error) => error === failure,
  );
  assert.throws(
    () =>
      verifyMacosPreSign(
        { appOutDir: '/tmp/output/linux', electronPlatformName: 'linux' },
        { sourceRoot: '/tmp/stage', verify: () => undefined },
      ),
    /non-macOS package/u,
  );
});
