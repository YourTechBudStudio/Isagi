import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, Ref } from 'effect';

import { CliAccess } from '../../cli-access/index.js';
import { UserShell } from '../../platform/process/index.js';
import { LaunchEnvironment } from '../launch-environment.js';

test('the launch base is the sanitized login shell plus CLI access, resolved per call', async () => {
  const runtimeUrl = Ref.makeUnsafe<string | null>(null);
  const cliAccess: CliAccess['Service'] = {
    publishRuntimeUrl: (url) => Ref.set(runtimeUrl, url),
    launchEnvironment: (basePath) =>
      Effect.map(Ref.get(runtimeUrl), (url) => ({
        PATH: `/isagi/bin:${basePath}`,
        ...(url === null ? {} : { ISAGI_RUNTIME_URL: url }),
      })),
  };
  const userShell: UserShell['Service'] = {
    environment: {
      _tag: 'Available',
      values: { HOME: '/home/developer', PATH: '/usr/bin', PORT: '5173', ISAGI_DEBUG: '1' },
    },
    run: () => Effect.die('not used'),
  };

  const [before, after] = await Effect.runPromise(
    Effect.gen(function* () {
      const environment = yield* LaunchEnvironment;
      const unpublished = yield* environment.base;
      yield* cliAccess.publishRuntimeUrl('http://127.0.0.1:4100');
      return [unpublished, yield* environment.base] as const;
    }).pipe(
      Effect.provide(
        LaunchEnvironment.layerNoDeps.pipe(
          Layer.provide([Layer.succeed(CliAccess, cliAccess), Layer.succeed(UserShell, userShell)]),
        ),
      ),
    ),
  );

  assert.equal(before.HOME, '/home/developer');
  assert.equal(before.PORT, undefined, 'runtime controls are removed');
  assert.equal(before.ISAGI_DEBUG, undefined, 'runtime controls are removed');
  assert.match(before.PATH ?? '', /^\/isagi\/bin:.*\/usr\/bin$/, 'CLI access wins on PATH');
  assert.equal(before.ISAGI_RUNTIME_URL, undefined);
  assert.equal(after.ISAGI_RUNTIME_URL, 'http://127.0.0.1:4100');
});
