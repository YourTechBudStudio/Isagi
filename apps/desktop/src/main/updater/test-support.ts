// Test-only fakes for the updater's dependencies: electron-updater, the configuration, the
// diagnostic trail and the runtime's HTTP API.
import { EventEmitter } from 'node:events';

import { Context, Effect, Exit, Layer, Scope, SubscriptionRef } from 'effect';
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from 'effect/http';

import type { DesktopUpdateSnapshot } from '@isagi/contracts';

import { DesktopUpdaterConfig, type UpdaterAdapter } from './config.js';
import { UpdaterDiagnostics, type UpdaterDiagnosticRecord } from './diagnostics.js';
import { DesktopUpdater } from './service.js';

export const testRuntimeUrl = 'http://127.0.0.1:43129';

export class FakeUpdater extends EventEmitter implements UpdaterAdapter {
  // Every flag starts at the opposite of what starting the updater must set, so
  // a configuration that silently stopped being applied cannot pass.
  allowPrerelease = true;
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  checks = 0;
  downloads = 0;
  installs = 0;
  rejection: Error | undefined;
  downloadRejection: Error | undefined;

  checkForUpdates() {
    this.checks += 1;
    return this.rejection ? Promise.reject(this.rejection) : Promise.resolve(null);
  }

  downloadUpdate() {
    this.downloads += 1;
    return this.downloadRejection ? Promise.reject(this.downloadRejection) : Promise.resolve(null);
  }

  quitAndInstall() {
    this.installs += 1;
  }

  override on(event: Parameters<UpdaterAdapter['on']>[0], listener: (...args: unknown[]) => void) {
    return super.on(event, listener);
  }

  override off(
    event: Parameters<UpdaterAdapter['off']>[0],
    listener: (...args: unknown[]) => void,
  ) {
    return super.off(event, listener);
  }
}

/** A packaged macOS configuration; every closure a test does not override fails loudly. */
export function testConfig(
  overrides: Partial<DesktopUpdaterConfig['Service']> = {},
): Layer.Layer<DesktopUpdaterConfig> {
  return Layer.succeed(
    DesktopUpdaterConfig,
    DesktopUpdaterConfig.of({
      platform: 'darwin',
      installedVersion: '1.2.3',
      isPackaged: true,
      environment: {},
      logsDirectory: () => {
        throw new Error('the logs directory is not used by this test');
      },
      loadUpdater: () => {
        throw new Error('electron-updater is not loaded by this test');
      },
      isExitCommitted: () => false,
      requestInstall: () => undefined,
      runtimeUrl: Effect.succeed(testRuntimeUrl),
      ...overrides,
    }),
  );
}

/** A trail that records every write in memory, in the order the writes ran. */
export function recordingDiagnostics() {
  const records: UpdaterDiagnosticRecord[] = [];
  const layer = Layer.succeed(
    UpdaterDiagnostics,
    UpdaterDiagnostics.of({ write: (record) => Effect.sync(() => void records.push(record)) }),
  );
  return { records, layer };
}

/** The runtime's HTTP API as an `HttpClient` whose every request is answered by `respond`. */
export function fakeRuntimeHttp(
  respond: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>,
): Layer.Layer<HttpClient.HttpClient> {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      respond(request).pipe(
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      ),
    ),
  );
}

/** The activity endpoint's success envelope. */
export function activityResponse(workingAgentCount: number) {
  return new Response(
    JSON.stringify({ data: { workingAgentCount }, meta: { requestId: 'request-1' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** An `HttpClient` no test path may reach. */
export const unusedRuntimeHttp = fakeRuntimeHttp(() =>
  Effect.die(new Error('the runtime is not reached by this test')),
);

/**
 * Lets every fiber that is ready to run do so: the updater applies events and settles promises on
 * its own fibers, so a test yields after `emit` before it asserts.
 */
export const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow;
});

/**
 * Builds `layer` in a scope the test closes itself (`stop`), standing in for main disposing the
 * desktop runtime. The scope is also closed when the test's own scope ends.
 */
export const buildUpdater = Effect.fnUntraced(function* (layer: Layer.Layer<DesktopUpdater>) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const context = yield* Layer.buildWithScope(layer, scope);
  const updater = Context.get(context, DesktopUpdater);
  yield* settle;
  return {
    updater,
    snapshot: (): DesktopUpdateSnapshot => SubscriptionRef.getUnsafe(updater.status),
    stop: Scope.close(scope, Exit.void),
  };
});
