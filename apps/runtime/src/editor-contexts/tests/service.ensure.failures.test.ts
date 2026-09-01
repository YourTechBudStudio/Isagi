import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { LoopbackPortUnavailable } from '../../lib/net/loopback-port-probe.js';
import { EditorContextRepository } from '../editor-contexts.repository.js';
import { EditorContextService } from '../editor-contexts.service.js';
import {
  editorContextChangedIds,
  insertWorktree,
  neverSettlingProbe,
  testInstallation,
  withEditorService,
} from '../test-support.js';
import type { EditorContextRow } from '../types.js';

/** The recorded reason's detail, asserted to exist by the caller's own case. */
function failureDetail(row: EditorContextRow | null | undefined): string {
  assert.ok(row?.attempt.state === 'failed' && row.attempt.detail !== null);
  return row.attempt.detail;
}

/**
 * Every Class B fault has to do both things: leave the reason on the row for
 * every future reader, and hand the same reason to the caller that asked. One
 * without the other is what the invariant exists to prevent — a pane showing a
 * failure nobody was told about, or an error nothing recorded.
 */
async function assertClassBFault(
  input: Parameters<typeof withEditorService>[0],
  expected: { readonly reason: string; readonly hasDetail: boolean },
) {
  const result = await withEditorService(input, (events) =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });

      const failure = yield* service
        .ensureRuntime({ editorContextId: created.id, intent: 'reuse' })
        .pipe(Effect.flip);
      const row = yield* repository.find(created.id);
      return { failure, row, changed: editorContextChangedIds(events) };
    }),
  );

  assert.equal(result.failure._tag, 'EditorLaunchFailed');
  assert.equal((result.failure as { reason: string }).reason, expected.reason);
  const attempt = result.row?.attempt;
  assert.ok(attempt !== undefined && attempt.state === 'failed');
  assert.equal(attempt.reason, expected.reason);
  // No pointer, no endpoint: the failure happened before anything was owned.
  assert.equal(result.row?.activePtyProcessId, null);
  assert.equal(result.row?.endpointPort, null);
  const { detail } = attempt;
  assert.equal(detail !== null, expected.hasDetail);
  assert.equal((result.failure as { detail: string | null }).detail, detail);
  // in_progress, then the failure.
  assert.equal(result.changed.length, 2);
  return result;
}

test('a missing launch target is persisted and raised', async () => {
  await assertClassBFault(
    {
      findWorktree: () => Effect.succeed(null),
      options: { probe: neverSettlingProbe },
    },
    { reason: 'launch_target_missing', hasDetail: false },
  );
});

test('a port allocation failure is persisted and raised with a redacted detail', async () => {
  const result = await assertClassBFault(
    {
      portProbe: {
        probeInactive: () => Effect.succeed(true),
        obtainEphemeralPort: Effect.fail(
          new LoopbackPortUnavailable({
            // A cause carrying a sentinel that must never reach the row.
            cause: new Error('SUPERSECRETTOKEN12345'),
          }),
        ),
      },
      options: { probe: neverSettlingProbe },
    },
    { reason: 'port_allocation_failed', hasDetail: true },
  );

  const detail = failureDetail(result.row);
  assert.ok(!detail.includes('SUPERSECRETTOKEN12345'), detail);
});

test('a socket path over the byte cap is refused before anything is allocated', async () => {
  const deepRoot = `/tmp/${'nested-directory/'.repeat(6)}isagi`;
  const result = await assertClassBFault(
    {
      installation: {
        ...testInstallation('/tmp/isagi-editor-socket'),
        sessionSocketDirectory: `${deepRoot}/editors/code-server/sock`,
      },
      options: { probe: neverSettlingProbe },
    },
    { reason: 'session_socket_unavailable', hasDetail: true },
  );

  assert.match(failureDetail(result.row), /session socket path exceeds 100 bytes/);
});

test('a failed handoff write is persisted and raised, and owns no process', async () => {
  const result = await assertClassBFault(
    {
      failDatabaseOperation: 'install_editor_incarnation',
      options: { probe: neverSettlingProbe },
    },
    { reason: 'launch_allocation_failed', hasDetail: true },
  );

  // The redacting classifier names the operation, never the underlying message.
  assert.match(failureDetail(result.row), /Database operation install_editor_incarnation failed/);
});

test('the port probe is never consulted when provisioning refuses first', async () => {
  const outcome = await withEditorService(
    {
      portProbe: {
        probeInactive: () => Effect.succeed(true),
        obtainEphemeralPort: Effect.die('provisioning must be checked before a port is taken'),
      },
      options: { probe: neverSettlingProbe },
    },
    () =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        // Reaching a *refusal* rather than the port probe is the assertion; the
        // context does not exist, so nothing may be allocated on its behalf.
        return yield* service
          .ensureRuntime({ editorContextId: 4_242, intent: 'reuse' })
          .pipe(Effect.flip);
      }),
  );

  assert.equal(outcome._tag, 'EditorError');
});
