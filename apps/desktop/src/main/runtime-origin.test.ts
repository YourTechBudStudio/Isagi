import assert from 'node:assert/strict';
import test from 'node:test';

import { managedRuntimeAllowedOrigins } from './runtime-origin.js';

test('packaged managed runtimes allow exactly the desktop file renderer origin', () => {
  const attemptedOverride = {
    mode: 'packaged',
    configuredAllowedOrigins: 'https://untrusted.example.test',
  } as const;

  assert.equal(managedRuntimeAllowedOrigins(attemptedOverride), 'file://');
});

test('development managed runtimes merge the required web origin with configured origins', () => {
  assert.equal(
    managedRuntimeAllowedOrigins({
      mode: 'development',
      webOrigin: 'http://127.0.0.1:43129',
      configuredAllowedOrigins: ' https://runtime-ui.example.test, http://127.0.0.1:43129, ',
    }),
    'http://127.0.0.1:43129,https://runtime-ui.example.test',
  );
});
