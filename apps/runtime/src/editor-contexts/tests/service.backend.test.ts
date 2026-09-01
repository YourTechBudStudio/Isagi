import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { PtyRepository } from '../../pty-processes/pty.repository.js';
import { EditorContextRepository } from '../editor-contexts.repository.js';
import { EditorContextService } from '../editor-contexts.service.js';
import { insertWorktree, neverSettlingProbe, withEditorService } from '../test-support.js';

test('an editor incarnation is node-pty even when tmux is the configured backend', async () => {
  const result = await withEditorService(
    { configured: 'tmux', options: { probe: neverSettlingProbe } },
    () =>
      Effect.gen(function* () {
        const service = yield* EditorContextService;
        const repository = yield* EditorContextRepository;
        const ptyRepository = yield* PtyRepository;
        const worktreeId = yield* insertWorktree('/repo/isagi');
        const created = yield* repository.create({ worktreeId });

        const facts = yield* service.ensureRuntime({
          editorContextId: created.id,
          intent: 'reuse',
        });
        return {
          facts,
          process: yield* ptyRepository.findProcess(facts.activePtyProcessId ?? -1),
        };
      }),
  );

  // Two consequences ride on this, and both are why the backend is pinned rather
  // than inherited: a tmux incarnation retains no startup output, and it would
  // survive a runtime restart holding this port and socket with no owner.
  assert.equal(result.process?.backend, 'node_pty');
  assert.equal(result.process?.logMode, 'backend_file');
  assert.notEqual(result.process?.logPath, null);
  assert.equal(result.facts.hasDiagnostics, true);
});
