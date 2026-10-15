import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Context, Effect, Layer } from 'effect';

import { makeLogCapture } from '../../../test/test-support.js';
import { HarnessObservationTargetsLayer } from '../../environment/index.js';
import { FluidcastSessions } from '../../fluidcast/index.js';
import { HarnessObservationTargets } from '../../harnesses/index.js';
import { DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { UserShell } from '../../platform/process/index.js';
import { RuntimeConfig } from '../../runtime-config/index.js';
import { WorkflowProjectErasure } from '../../workflows/index.js';
import { StateFile } from '../../workspace/index.js';
import { ModulesLayer } from '../layer.js';

/**
 * The composition root's structural guarantees, over the real module graph: every service wires its own module
 * dependencies by reference, so a service several modules depend on is still one instance, and the scope tree
 * releases dependents before what they depend on.
 *
 * The database is counted where it is built. The harness observer is counted through its port: building it reads every
 * observation target exactly once (its startup inventory), and the environment's attention projection and the workflow
 * engine both depend on it, so a second observer would read them twice.
 */
test('the app layer builds the database and the harness observer once and releases the platform last', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-composition-'));
  const released: string[] = [];
  let databaseBuilds = 0;
  let startupInventoryReads = 0;

  const dataDirectory = Layer.effect(
    DataDirectory,
    Effect.acquireRelease(
      Effect.sync(() => makeTestDataDirectory(dataRoot)),
      () => Effect.sync(() => released.push('data directory')),
    ),
  );
  const database = Layer.effect(
    RuntimeDatabase,
    Effect.gen(function* () {
      databaseBuilds += 1;
      yield* Effect.addFinalizer(() => Effect.sync(() => released.push('database')));
      return yield* RuntimeDatabase;
    }),
  ).pipe(Layer.provide(RuntimeDatabase.layer));
  // Never spawns the login shell: nothing in construction runs a user-shell command.
  const userShell = Layer.succeed(
    UserShell,
    UserShell.of({
      environment: { _tag: 'Available', values: { HOME: dataRoot, PATH: '/usr/bin:/bin' } },
      run: () => Effect.die('composition test runs no user-shell command'),
    }),
  );
  const platform = Layer.mergeAll(database, StateFile.layer, RuntimeConfig.layer, userShell).pipe(
    Layer.provideMerge(dataDirectory),
  );
  const observationTargets = Layer.effect(
    HarnessObservationTargets,
    Effect.gen(function* () {
      const targets = yield* HarnessObservationTargets;
      yield* Effect.addFinalizer(() => Effect.sync(() => released.push('observation targets')));
      return HarnessObservationTargets.of({
        list: (input) => {
          if (input.mode === 'all') startupInventoryReads += 1;
          return targets.list(input);
        },
      });
    }),
  ).pipe(Layer.provide(HarnessObservationTargetsLayer));
  const app = ModulesLayer.pipe(
    Layer.provide([WorkflowProjectErasure, observationTargets]),
    Layer.provideMerge(platform),
  );

  try {
    await Effect.runPromise(Effect.scoped(Layer.build(app)));

    assert.equal(databaseBuilds, 1);
    assert.equal(startupInventoryReads, 1);
    assert.deepEqual(
      released.filter((entry) =>
        ['observation targets', 'database', 'data directory'].includes(entry),
      ),
      ['observation targets', 'database', 'data directory'],
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

/** Builds the real module graph over `configYaml`, returning what Fluidcast reports and every log line. */
async function buildWithConfig(configYaml: string | null) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-composition-fluidcast-'));
  if (configYaml !== null) writeFileSync(join(dataRoot, 'config.yaml'), configYaml, 'utf8');
  const capture = makeLogCapture();
  const userShell = Layer.succeed(
    UserShell,
    UserShell.of({
      environment: { _tag: 'Available', values: { HOME: dataRoot, PATH: '/usr/bin:/bin' } },
      run: () => Effect.die('composition test runs no user-shell command'),
    }),
  );
  const platform = Layer.mergeAll(
    RuntimeDatabase.layer,
    StateFile.layer,
    RuntimeConfig.layer,
    userShell,
  ).pipe(Layer.provideMerge(Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot))));
  const app = ModulesLayer.pipe(
    Layer.provide([WorkflowProjectErasure, HarnessObservationTargetsLayer]),
    Layer.provideMerge(platform),
  );
  try {
    const availability = await Effect.runPromise(
      Effect.scoped(
        Effect.map(
          Layer.build(app),
          (context) => Context.get(context, FluidcastSessions).availability,
        ),
      ).pipe(Effect.provide(capture.layer)),
    );
    return { availability, logs: JSON.stringify(capture.lines) };
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

const dummyKey = 'sk-composition-SENTINEL-41d2';

test('the app layer builds with Fluidcast disabled, ready or invalid', async () => {
  assert.equal((await buildWithConfig(null)).availability, 'disabled');

  const ready = await buildWithConfig(
    [
      'fluidcast:',
      '  enabled: true',
      '  languageModel:',
      '    provider: openai',
      `    apiKey: ${dummyKey}`,
      '    model: gpt-test',
      '  speech:',
      '    model: tts-test',
      `    apiKey: ${dummyKey}`,
      '  preset:',
      '    voice:',
      '      name: alloy',
      '',
    ].join('\n'),
  );
  assert.equal(ready.availability, 'ready');
  assert.equal(ready.logs.includes(dummyKey), false, 'a dummy key reached the logs');

  const invalid = await buildWithConfig(
    `fluidcast:\n  enabled: true\n  speech:\n    apiKey: ${dummyKey}\n`,
  );
  assert.equal(invalid.availability, 'invalid');
  assert.match(invalid.logs, /fluidcast config invalid/);
  assert.equal(invalid.logs.includes(dummyKey), false, 'a dummy key reached the logs');
});
