import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Effect } from 'effect';

import type {
  ControlPlaneSnapshot,
  DocsReconciliationResult,
  HarnessControlPlaneEntry,
} from '@isagi/shared/contracts';
import { RuntimeTransportError } from '@isagi/shared/runtime-client';

import { harnessRefreshCopy, runtimeErrorCopy } from '../../../copy/index.js';
import { controlPlaneQuery } from '../../control-plane/queries.js';
import type { RuntimeApiShape } from '../../runtime/client.js';
import { flush, makeTestRegistry } from '../../state/testing.js';
import { assembleEntries } from '../entries.js';
import { GLOBAL_COMMANDS } from '../registry.js';
import { paletteTestSession } from '../test-support.js';
import type { CommandOutcome, PaletteContext } from '../types.js';
import { refreshHarnessesCommand } from './refresh-harnesses.js';

/**
 * The runtime checks for agent binaries once at startup. This command is the
 * explicit recheck: refresh the inventory, then read the control plane fresh so
 * the picker and unavailable panes see what the recheck found.
 */

test('the command is registered as a global command', () => {
  assert.ok(GLOBAL_COMMANDS.includes(refreshHarnessesCommand));
});

test('its palette entry carries the command, so the palette reads its running copy', (t) => {
  const { context } = session(t, {});
  const paletteEntry = assembleEntries(context).find(
    (row) => row.id === refreshHarnessesCommand.id,
  );
  assert.equal(paletteEntry?.command, refreshHarnessesCommand);
  assert.deepEqual(paletteEntry.command.running, harnessRefreshCopy.running);
});

test('refreshes the inventory, then reads the new snapshot and reports what is ready', async (t) => {
  const calls: string[] = [];
  let generation = 1;
  const { context, registry } = session(t, {
    refreshInventory: () =>
      Effect.sync(() => {
        calls.push('refresh');
        generation = 2;
        return { generation };
      }),
    getControlPlane: () =>
      Effect.sync(() => {
        calls.push(`read:${generation}`);
        return generation === 1
          ? snapshot([entry('claude', 'harness_probe_failed')])
          : snapshot([entry('claude'), entry('codex'), entry('pi', 'harness_missing')]);
      }),
  });

  // The query is already held with the stale startup snapshot, as in the app.
  const unmount = registry.mount(controlPlaneQuery);
  t.after(unmount);
  await flush();
  assert.deepEqual(calls, ['read:1']);

  const outcome = await run(context);

  assert.equal(calls.at(-2), 'refresh');
  assert.equal(calls.at(-1), 'read:2', 'the read begins after the refresh settled');
  assert.deepEqual(outcome, {
    kind: 'result',
    content: {
      tone: 'success',
      title: harnessRefreshCopy.ready.title,
      body: 'Ready to start: Claude, Codex. Not ready: Pi (Not installed).',
    },
  });
});

test('reports a warning naming each harness when none is ready', async (t) => {
  const { context } = session(t, {
    refreshInventory: () => Effect.succeed({ generation: 2 }),
    getControlPlane: () =>
      Effect.succeed(
        snapshot([entry('claude', 'harness_missing'), entry('codex', 'harness_disabled')]),
      ),
  });

  assert.deepEqual(await run(context), {
    kind: 'result',
    content: {
      tone: 'warning',
      title: harnessRefreshCopy.noneReady.title,
      body: 'Not ready: Claude (Not installed), Codex (Disabled).',
    },
  });
});

test('a docs install that failed during this refresh is a warning with framed detail', async (t) => {
  const { context } = session(t, {
    refreshInventory: () => Effect.succeed({ generation: 2 }),
    getControlPlane: () =>
      Effect.succeed(
        snapshot(
          [entry('claude'), entry('codex')],
          docsResult(2, [
            { harness: 'claude', action: 'unchanged' },
            {
              harness: 'codex',
              action: 'failed',
              reason: 'publication_failed',
              diagnostic: 'EACCES: ~/.codex/skills',
            },
          ]),
        ),
      ),
  });

  assert.deepEqual(await run(context), {
    kind: 'result',
    content: {
      tone: 'warning',
      title: harnessRefreshCopy.docsFailed.title,
      body: 'Ready to start: Claude, Codex. isagi-docs failed for Codex.',
      diagnostic: {
        label: harnessRefreshCopy.docsFailed.diagnosticLabel,
        detail: "Codex: isagi couldn't write the docs files.\n  EACCES: ~/.codex/skills",
      },
    },
  });
});

test('a docs failure from an older inventory generation is not reported as this refresh', async (t) => {
  const { context } = session(t, {
    refreshInventory: () => Effect.succeed({ generation: 3 }),
    getControlPlane: () =>
      Effect.succeed(
        snapshot(
          [entry('claude')],
          docsResult(2, [{ harness: 'claude', action: 'failed', reason: 'publication_failed' }]),
        ),
      ),
  });

  const outcome = await run(context);
  assert.equal(outcome?.kind === 'result' && outcome.content.tone, 'success');
});

test('a docs failure from a newer generation (a refresh landed before the read) stays visible', async (t) => {
  const { context } = session(t, {
    refreshInventory: () => Effect.succeed({ generation: 2 }),
    getControlPlane: () =>
      Effect.succeed(
        snapshot(
          [entry('claude')],
          docsResult(3, [{ harness: 'claude', action: 'failed', reason: 'publication_failed' }]),
        ),
      ),
  });

  const outcome = await run(context);
  assert.equal(outcome?.kind, 'result');
  assert.equal(outcome.content.tone, 'warning');
  assert.equal(outcome.content.title, harnessRefreshCopy.docsFailed.title);
  assert.equal(outcome.content.diagnostic?.detail, "Claude: isagi couldn't write the docs files.");
});

test('a failed refresh is an error in the palette and skips the read', async (t) => {
  let read = false;
  const { context } = session(t, {
    refreshInventory: () => Effect.fail(transportFailure()),
    getControlPlane: () =>
      Effect.sync(() => {
        read = true;
        return snapshot([]);
      }),
  });

  const outcome = await run(context);

  assert.equal(outcome?.kind, 'error');
  assert.equal(outcome.content.title, harnessRefreshCopy.refreshFailed.title);
  assert.equal(outcome.content.body, runtimeErrorCopy.transport);
  assert.equal(read, false);
});

test('a failed re-read says the recheck ran but its result did not load', async (t) => {
  const { context } = session(t, {
    refreshInventory: () => Effect.succeed({ generation: 2 }),
    getControlPlane: () => Effect.fail(transportFailure()),
  });

  const outcome = await run(context);

  assert.equal(outcome?.kind, 'error');
  assert.equal(outcome.content.tone, 'warning');
  assert.equal(outcome.content.title, harnessRefreshCopy.readFailed.title);
});

async function run(context: PaletteContext): Promise<CommandOutcome | undefined> {
  return (await refreshHarnessesCommand.run({}, context)) ?? undefined;
}

function session(t: TestContext, api: Partial<RuntimeApiShape>) {
  const registry = makeTestRegistry({ api, retry: false });
  t.after(() => registry.dispose());
  const context: PaletteContext = {
    projects: [],
    activeProject: null,
    activeWorktree: null,
    activeSurface: null,
    activePaneId: null,
    ...paletteTestSession(registry),
    launchableHarnesses: [],
    editorAvailable: false,
  };
  return { context, registry };
}

function transportFailure() {
  return new RuntimeTransportError({
    endpointId: 'controlPlane.refreshInventory',
    cause: new Error('offline'),
  });
}

function entry(
  harness: HarnessControlPlaneEntry['harness'],
  blocked?: Extract<HarnessControlPlaneEntry['launch'], { status: 'blocked' }>['reason'],
): HarnessControlPlaneEntry {
  return {
    harness,
    availability: blocked === 'harness_missing' ? 'missing' : 'available',
    policy: { enabled: blocked !== 'harness_disabled', installIsagiDocs: false },
    launch: blocked ? { status: 'blocked', reason: blocked } : { status: 'launchable' },
  };
}

function docsResult(
  inventoryGeneration: number,
  results: readonly {
    readonly harness: HarnessControlPlaneEntry['harness'];
    readonly action: DocsReconciliationResult['results'][number]['action'];
    readonly reason?: DocsReconciliationResult['results'][number]['reason'];
    readonly diagnostic?: string;
  }[],
): DocsReconciliationResult {
  return {
    outcome: results.some((result) => result.action === 'failed')
      ? 'partially_failed'
      : 'succeeded',
    policyRevision: 'rev-1',
    inventoryGeneration,
    fingerprint: 'fp',
    results: results.map((result) => ({
      harness: result.harness,
      availability: 'available',
      action: result.action,
      reason: result.reason ?? null,
      destination: null,
      diagnostic: result.diagnostic ?? null,
    })),
  };
}

function snapshot(
  harnesses: readonly HarnessControlPlaneEntry[],
  lastResult: DocsReconciliationResult | null = null,
): ControlPlaneSnapshot {
  return {
    onboardingComplete: true,
    configStatus: 'valid',
    configDiagnostic: null,
    policyRevision: 'rev-1',
    inventory: { status: 'ready', generation: 1, environment: 'trusted' },
    harnesses,
    reconciliation: {
      desiredFingerprint: null,
      runningFingerprint: null,
      lastCompletedFingerprint: null,
      lastAppliedFingerprint: null,
      lastResult,
    },
    editorProvisioning: { status: 'ready', version: '4.135.0' },
  };
}
