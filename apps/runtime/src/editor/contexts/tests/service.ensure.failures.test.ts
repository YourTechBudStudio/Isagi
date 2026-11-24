import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import {
  editorContextChangedIds,
  insertWorktree,
  neverSettlingProbe,
  testInstallation,
  withEditorService,
} from '../../testing.js';
import { EditorContextRepository } from '../repository.js';
import { EditorContextService } from '../service.js';
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
  // No pointer, no socket: the failure happened before anything was owned.
  assert.equal(result.row?.activePtyProcessId, null);
  assert.equal(result.row?.sessionSocketPath, null);
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

  assert.match(failureDetail(result.row), /editor socket path exceeds 100 bytes/);
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

test('the launch target is never consulted when the context is refused first', async () => {
  const outcome = await withEditorService(
    {
      findWorktree: () => Effect.die('the context must be checked before a launch is prepared'),
      options: { probe: neverSettlingProbe },
    },
    () =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        // Reaching a *refusal* rather than preparation is the assertion; the
        // context does not exist, so nothing may be allocated on its behalf.
        return yield* service
          .ensureRuntime({ editorContextId: 4_242, intent: 'reuse' })
          .pipe(Effect.flip);
      }),
  );

  assert.equal(outcome._tag, 'EditorError');
});
