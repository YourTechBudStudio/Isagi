import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect, Layer, Ref } from 'effect';

import type { ProcessTokenHolder } from '../../access/index.js';
import { CliAccess } from '../../cli-access/index.js';
import { UserShell } from '../../platform/process/index.js';
import { LaunchEnvironment } from '../launch-environment.js';

function fixture() {
  const runtimeUrl = Ref.makeUnsafe<string | null>(null);
  const holders: ProcessTokenHolder[] = [];
  const cliAccess: CliAccess['Service'] = {
    publishRuntimeUrl: (url) => Ref.set(runtimeUrl, url),
    launchEnvironment: (basePath, holder) =>
      Effect.map(Ref.get(runtimeUrl), (url) => {
        holders.push(holder);
        return {
          PATH: `/isagi/bin:${basePath}`,
          ISAGI_RUNTIME_TOKEN: `token-${holders.length}`,
          ...(url === null ? {} : { ISAGI_RUNTIME_URL: url }),
        };
      }),
  };
  const userShell: UserShell['Service'] = {
    environment: {
      _tag: 'Available',
      values: { HOME: '/home/developer', PATH: '/usr/bin', PORT: '5173', ISAGI_DEBUG: '1' },
    },
    run: () => Effect.die('not used'),
  };
  const layer = LaunchEnvironment.layerNoDeps.pipe(
    Layer.provide([Layer.succeed(CliAccess, cliAccess), Layer.succeed(UserShell, userShell)]),
  );
  return { cliAccess, holders, layer };
}

test('a process environment is the sanitized login shell plus CLI access, resolved per call', async () => {
  const { cliAccess, holders, layer } = fixture();
  const holder = { _tag: 'pty', ptyProcessId: 7 } as const;

  const [before, after] = await Effect.runPromise(
    Effect.gen(function* () {
      const environment = yield* LaunchEnvironment;
      const unpublished = yield* environment.forProcess(holder);
      yield* cliAccess.publishRuntimeUrl('http://127.0.0.1:4100');
      return [unpublished, yield* environment.forProcess(holder)] as const;
    }).pipe(Effect.provide(layer)),
  );

  assert.equal(before.HOME, '/home/developer');
  assert.equal(before.PORT, undefined, 'runtime controls are removed');
  assert.equal(before.ISAGI_DEBUG, undefined, 'runtime controls are removed');
  assert.match(before.PATH ?? '', /^\/isagi\/bin:.*\/usr\/bin$/, 'CLI access wins on PATH');
  assert.equal(before.ISAGI_RUNTIME_URL, undefined);
  assert.equal(before.ISAGI_RUNTIME_TOKEN, 'token-1', 'the CLI token is in the environment');
  assert.equal(after.ISAGI_RUNTIME_URL, 'http://127.0.0.1:4100');
  assert.deepEqual(holders, [holder, holder], 'each call asks CLI access for that holder');
});

test('the user environment carries no CLI variables and issues no token', async () => {
  const { holders, layer } = fixture();

  const user = await Effect.runPromise(
    Effect.gen(function* () {
      return (yield* LaunchEnvironment).userEnvironment;
    }).pipe(Effect.provide(layer)),
  );

  assert.equal(user.HOME, '/home/developer');
  assert.doesNotMatch(user.PATH ?? '', /isagi/, 'the shim directory is not on PATH');
  assert.equal(user.ISAGI_RUNTIME_TOKEN, undefined);
  assert.equal(user.ISAGI_RUNTIME_URL, undefined);
  assert.equal(user.ISAGI_DEBUG, undefined);
  assert.deepEqual(holders, []);
});
