import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import { Effect } from 'effect';

import { PtyRepository } from '../../pty-processes/pty.repository.js';
import { EditorContextRepository } from '../editor-contexts.repository.js';
import { EditorContextService, editorDiagnosticsMaxBytes } from '../editor-contexts.service.js';
import { insertWorktree, neverSettlingProbe, withEditorService } from './test-support.js';

function launched() {
  return Effect.gen(function* () {
    const service = yield* EditorContextService;
    const repository = yield* EditorContextRepository;
    const worktreeId = yield* insertWorktree('/repo/isagi');
    const created = yield* repository.create({ worktreeId });
    const facts = yield* service.ensureRuntime({
      editorContextId: created.id,
      intent: 'reuse',
    });
    return { service, repository, editorContextId: created.id, facts };
  });
}

test('the tail is bounded and reports truncation honestly', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const { service, facts } = yield* launched();
      const ptyRepository = yield* PtyRepository;
      const ptyProcessId = facts.activePtyProcessId ?? -1;
      const process = yield* ptyRepository.findProcess(ptyProcessId);
      const body = 'x'.repeat(editorDiagnosticsMaxBytes * 2);
      writeFileSync(process?.logPath ?? '', body, 'utf8');

      return yield* service.diagnostics({ editorContextId: facts.id, ptyProcessId });
    }),
  );

  assert.equal(result.excerpt?.length, editorDiagnosticsMaxBytes);
  assert.equal(result.truncated, true);
  assert.equal(result.totalBytes, editorDiagnosticsMaxBytes * 2);
});

test('a short log is returned whole and untruncated', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const { service, facts } = yield* launched();
      const ptyRepository = yield* PtyRepository;
      const ptyProcessId = facts.activePtyProcessId ?? -1;
      const process = yield* ptyRepository.findProcess(ptyProcessId);
      writeFileSync(process?.logPath ?? '', 'code-server failed to bind\n', 'utf8');

      return yield* service.diagnostics({ editorContextId: facts.id, ptyProcessId });
    }),
  );

  assert.equal(result.excerpt, 'code-server failed to bind\n');
  assert.equal(result.truncated, false);
});

test('an existing but empty log answers with an empty excerpt, not a null one', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const { service, facts } = yield* launched();
      // The incarnation produced no output. That is a different fact from
      // retaining no log at all, and the contract keeps them apart.
      return yield* service.diagnostics({
        editorContextId: facts.id,
        ptyProcessId: facts.activePtyProcessId ?? -1,
      });
    }),
  );

  assert.equal(result.excerpt, '');
  assert.equal(result.truncated, false);
  assert.equal(result.totalBytes, 0);
});

test('a log that is no longer on disk answers null rather than failing', async () => {
  const result = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const { service, facts } = yield* launched();
      const ptyRepository = yield* PtyRepository;
      const ptyProcessId = facts.activePtyProcessId ?? -1;
      const process = yield* ptyRepository.findProcess(ptyProcessId);
      // The orphan-log sweep removes files whose rows are gone; nothing is
      // retained, and that is an answer rather than an error.
      rmSync(process?.logPath ?? '', { force: true });

      return yield* service.diagnostics({ editorContextId: facts.id, ptyProcessId });
    }),
  );

  assert.equal(result.excerpt, null);
  assert.equal(result.truncated, false);
  assert.equal(result.totalBytes, null);
});

test('a superseded incarnation is refused rather than answered from the current one', async () => {
  const failure = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const { service, editorContextId, facts } = yield* launched();
      const previous = facts.activePtyProcessId ?? -1;
      yield* service.ensureRuntime({ editorContextId, intent: 'replace' });

      // Serving the new incarnation's output under the old one's id would
      // misattribute the very evidence the user was asked to report.
      return yield* service
        .diagnostics({ editorContextId, ptyProcessId: previous })
        .pipe(Effect.flip);
    }),
  );

  assert.equal(failure._tag, 'EditorError');
  assert.equal((failure as { code: string }).code, 'editor_incarnation_superseded');
});

test('a context with no incarnation refuses every diagnostics read', async () => {
  const failure = await withEditorService({ options: { probe: neverSettlingProbe } }, () =>
    Effect.gen(function* () {
      const service = yield* EditorContextService;
      const repository = yield* EditorContextRepository;
      const worktreeId = yield* insertWorktree('/repo/isagi');
      const created = yield* repository.create({ worktreeId });
      return yield* service
        .diagnostics({ editorContextId: created.id, ptyProcessId: 1 })
        .pipe(Effect.flip);
    }),
  );

  assert.equal((failure as { code: string }).code, 'editor_incarnation_superseded');
});
