import assert from 'node:assert/strict';
import test from 'node:test';

import { Context, Effect, Layer } from 'effect';

import { DesktopUpdaterConfig } from './config.js';

class RuntimeUrlSource extends Context.Service<RuntimeUrlSource, { readonly url: string }>()(
  'isagi/desktop/updater/test/RuntimeUrlSource',
) {}

test('the Electron configuration binds the runtime URL services and asks for the logs path lazily', async () => {
  const asked: string[] = [];
  const application = {
    isPackaged: true,
    getVersion: () => '1.2.3',
    getPath: (name: string) => {
      asked.push(name);
      return '/logs';
    },
  } as unknown as Parameters<typeof DesktopUpdaterConfig.layerElectron>[0];
  const requested: (() => void)[] = [];
  const layer = DesktopUpdaterConfig.layerElectron(application, {
    runtimeUrl: RuntimeUrlSource.use((source) => Effect.succeed(source.url)),
    isExitCommitted: () => false,
    requestInstall: (install) => void requested.push(install),
  }).pipe(
    Layer.provide(Layer.succeed(RuntimeUrlSource, RuntimeUrlSource.of({ url: 'http://runtime' }))),
  );

  const url = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* DesktopUpdaterConfig;
        assert.equal(config.installedVersion, '1.2.3');
        assert.equal(config.isPackaged, true);
        assert.deepEqual(asked, [], 'the logs path was read before any diagnostic needed it');
        assert.equal(config.logsDirectory(), '/logs');
        config.requestInstall(() => undefined);
        // The configured effect carries no requirements of its own.
        return yield* config.runtimeUrl;
      }).pipe(Effect.provide(layer)),
    ),
  );
  assert.equal(url, 'http://runtime');
  assert.deepEqual(asked, ['logs']);
  assert.equal(requested.length, 1);
});
