import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { PtyRepository } from '../../../pty-processes/testing.js';
import { insertWorktree, neverSettlingProbe, withEditorService } from '../../testing.js';
import { EditorContextRepository } from '../repository.js';
import { EditorContextService } from '../service.js';

test('an editor incarnation is a node-pty process with a file log', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
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

  // Code Server relies on this: the file log retains its startup output for
  // diagnostics, and the process is owned by the runtime that launched it.
  assert.equal(result.process?.backend, 'node_pty');
  assert.equal(result.process?.logMode, 'backend_file');
  assert.notEqual(result.process?.logPath, null);
  assert.equal(result.facts.hasDiagnostics, true);
});
