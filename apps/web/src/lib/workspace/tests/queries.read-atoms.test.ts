// The worktree-scoped read atoms (command catalog, log metadata, surface detail, active context)
// and the command action fn atoms.
import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';

import { Effect } from 'effect';

import type {
  ActiveContextOutput,
  CommandActionOutput,
  CommandLogMetadataOutput,
  SurfaceDetail,
  WorktreeCommandsOutput,
} from '@isagi/contracts';
import { RuntimeTransportError } from '@isagi/runtime-client';

import { keys } from '../../state/keys.js';
import { mutationError } from '../../state/result.js';
import { invalidateKeys } from '../../state/runtime.js';
import { advance, controllable, flush, makeTestRegistry } from '../../state/testing.js';
import {
  activeContextAtom,
  commandActionAtoms,
  commandLogMetadataAtom,
  paletteCommandsAtom,
  readCommandsOnPaletteOpen,
  surfaceDetailAtom,
  worktreeCommandsAtom,
} from '../queries.js';

const useMockTime = (t: TestContext) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
};

const catalog = { status: 'configured' } as unknown as WorktreeCommandsOutput;
const metadata = { latestRun: null } as unknown as CommandLogMetadataOutput;
const down = () => new RuntimeTransportError({ endpointId: 'commands.run', cause: 'down' });

/** A fake runtime that counts command reads per worktree and per command. */
function commandsRuntime(t: TestContext, overrides: Parameters<typeof makeTestRegistry>[0] = {}) {
  const catalogReads: number[] = [];
  const metadataReads: string[] = [];
  const registry = makeTestRegistry({
    ...overrides,
    api: {
      fetchWorktreeCommands: (worktreeId) =>
        Effect.sync(() => (catalogReads.push(worktreeId), catalog)),
      fetchCommandLogMetadata: (worktreeId, commandName) =>
        Effect.sync(() => (metadataReads.push(`${worktreeId}:${commandName}`), metadata)),
      ...overrides.api,
    },
  });
  t.after(() => registry.dispose());
  return { registry, catalogReads, metadataReads };
}

test('invalidating a catalog spares its commands log metadata', async (t) => {
  const { registry, catalogReads, metadataReads } = commandsRuntime(t);
  const unmount = [
    registry.mount(worktreeCommandsAtom(10)),
    registry.mount(worktreeCommandsAtom(11)),
    registry.mount(commandLogMetadataAtom([10, 'dev'])),
  ];
  await flush();
  invalidateKeys(registry, [keys.commands(10)]);
  await flush();
  assert.deepEqual(catalogReads.toSorted(), [10, 10, 11]);
  assert.deepEqual(metadataReads, ['10:dev']);
  unmount.forEach((release) => release());
});

/** What `CommandPalette` does on open: read now, then show and poll the palette view. */
const openPaletteOn = (registry: ReturnType<typeof makeTestRegistry>, worktreeId: number) => {
  readCommandsOnPaletteOpen(registry, worktreeId);
  return registry.mount(paletteCommandsAtom(worktreeId));
};

test('the palette reads the catalog on every open and polls only while it is open', async (t) => {
  useMockTime(t);
  const { registry, catalogReads } = commandsRuntime(t);
  const strip = registry.mount(worktreeCommandsAtom(10));
  await flush();
  assert.equal(catalogReads.length, 1);

  let palette = openPaletteOn(registry, 10);
  await flush();
  assert.equal(catalogReads.length, 2, 'opening reads although the shared data is fresh');
  await advance(10_000);
  assert.equal(catalogReads.length, 3, 'polls every 10 s while open');
  palette();
  await advance(30_000);
  assert.equal(catalogReads.length, 3, 'no polling once closed');
  palette = openPaletteOn(registry, 10);
  await flush();
  assert.equal(catalogReads.length, 4, 'the next open reads again');
  palette();
  strip();
});

test('a palette closed right after opening still reads, and an open joins a read in flight', async (t) => {
  const reads = controllable<WorktreeCommandsOutput>();
  const registry = makeTestRegistry({ api: { fetchWorktreeCommands: () => reads.effect } });
  t.after(() => registry.dispose());
  const strip = registry.mount(worktreeCommandsAtom(10));
  await flush();
  // The strip's first read is still running: opening does not restart it.
  openPaletteOn(registry, 10)();
  await flush();
  assert.equal(reads.calls.length, 1);
  assert.equal(reads.calls[0]!.aborted, false);
  reads.last().resolve(catalog);
  await flush();

  // Opened and closed before anything else ran: the read was already sent, and it lands.
  openPaletteOn(registry, 10)();
  assert.equal(reads.calls.length, 2);
  reads.last().resolve({ status: 'config_error' } as unknown as WorktreeCommandsOutput);
  await flush();
  assert.equal(
    (registry.get(worktreeCommandsAtom(10)) as { value?: WorktreeCommandsOutput }).value?.status,
    'config_error',
  );
  strip();
});

test('a command action stays pending until the catalog and its log metadata are re-read', async (t) => {
  const runs = controllable<CommandActionOutput, RuntimeTransportError>();
  const catalogReads = controllable<WorktreeCommandsOutput>();
  let metadataReads = 0;
  const registry = makeTestRegistry({
    api: {
      runCommand: (worktreeId, commandName) =>
        Effect.suspend(() => {
          assert.equal(worktreeId, 10);
          assert.equal(commandName, 'dev');
          return runs.effect;
        }),
      fetchWorktreeCommands: () => catalogReads.effect,
      fetchCommandLogMetadata: () => Effect.sync(() => (metadataReads++, metadata)),
    },
  });
  t.after(() => registry.dispose());
  const unmountCatalog = registry.mount(worktreeCommandsAtom(10));
  const unmountMetadata = registry.mount(commandLogMetadataAtom([10, 'dev']));
  catalogReads.last().resolve(catalog);
  await flush();

  const { run } = commandActionAtoms(10);
  const unmountRun = registry.mount(run);
  registry.set(run, 'dev');
  await flush();
  runs.last().reject(down());
  await flush();
  assert.equal(catalogReads.calls.length, 2, 'a failed run re-reads the catalog too');
  assert.equal(registry.get(run).waiting, true, 'pending while the catalog re-read runs');
  assert.equal(mutationError(registry.get(run)), null);
  catalogReads.last().resolve(catalog);
  await flush();
  assert.equal(metadataReads, 2, 'then the log metadata');
  assert.equal(registry.get(run).waiting, false);
  assert.ok(mutationError(registry.get(run)) instanceof RuntimeTransportError);
  unmountRun();
  unmountMetadata();
  unmountCatalog();
});

test('command actions belong to their instance and need a worktree', async (t) => {
  const runs = controllable<CommandActionOutput, RuntimeTransportError>();
  const { registry } = commandsRuntime(t, { api: { runCommand: () => runs.effect } });
  const list = commandActionAtoms(10);
  const detail = commandActionAtoms(10);
  const unmount = [registry.mount(list.run), registry.mount(detail.run)];
  registry.set(list.run, 'dev');
  await flush();
  assert.equal(registry.get(list.run).waiting, true);
  assert.equal(registry.get(detail.run).waiting, false, 'the other instance is not pending');

  // A second click does not abort the request already sent.
  registry.set(list.run, 'dev');
  await flush();
  assert.equal(runs.calls[0]!.aborted, false);

  const none = commandActionAtoms(null);
  unmount.push(registry.mount(none.stop));
  registry.set(none.stop, 'dev');
  await flush();
  assert.equal(
    (mutationError(registry.get(none.stop)) as Error).message,
    'Command stop requires an active worktree.',
  );
  unmount.forEach((release) => release());
});

test('surface detail is kept for the session and re-read only by its own key', async (t) => {
  useMockTime(t);
  const reads: number[] = [];
  const registry = makeTestRegistry({
    api: {
      getSurfaceDetail: (surfaceId) =>
        Effect.sync(() => (reads.push(surfaceId), { id: surfaceId } as unknown as SurfaceDetail)),
    },
  });
  t.after(() => registry.dispose());
  let unmount = registry.mount(surfaceDetailAtom(12));
  const other = registry.mount(surfaceDetailAtom(13));
  await flush();
  invalidateKeys(registry, [keys.surface(13)]);
  await flush();
  assert.deepEqual(reads.toSorted(), [12, 13, 13]);

  unmount();
  await advance(30 * 60_000);
  unmount = registry.mount(surfaceDetailAtom(12));
  assert.equal(registry.get(surfaceDetailAtom(12))._tag, 'Success', 'still cached after 30 min');
  unmount();
  other();
});

test('the active-context atom is re-read by its own key, not the workspace key', async (t) => {
  let reads = 0;
  const registry = makeTestRegistry({
    api: {
      fetchActiveContext: () =>
        Effect.sync(() => (reads++, { activeContext: null } as unknown as ActiveContextOutput)),
    },
  });
  t.after(() => registry.dispose());
  const unmount = registry.mount(activeContextAtom);
  await flush();
  invalidateKeys(registry, [keys.workspace]);
  await flush();
  assert.equal(reads, 1);
  invalidateKeys(registry, [keys.activeContext]);
  await flush();
  assert.equal(reads, 2);
  unmount();
});
