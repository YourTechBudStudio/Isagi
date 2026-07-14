import assert from 'node:assert/strict';
import test from 'node:test';

import { workflowLoadFailureReasonSchema } from '@isagi/contracts';

import { paletteCopy, workflowLoadFailureReasonCopy } from '../../copy/index.js';
import { assembleEntries, workflowFailureEntry } from './entries.js';
import type { CommandErrorContent, PaletteContext, PaletteEntry } from './types.js';

test('active worktree action entries freeze the active project and worktree ids', () => {
  const entries = assembleEntries(ctx());
  const entry = entries.find((candidate) => candidate.id === 'delete-active-worktree');

  assert.deepEqual(entry?.values, { projectId: '1', worktreeId: '11' });
});

test('workflow descriptors assemble into workflow entries', () => {
  const entries = assembleEntries(
    ctx({
      workflowDescriptors: [
        {
          ok: true,
          workflowKey: 'release',
          manifest: {
            title: 'Release',
            description: 'Runs the release checklist.',
            inputs: [{ kind: 'text', key: 'version', label: 'Version' }],
          },
        },
      ],
    }),
  );

  const entry = entries.find((candidate) => candidate.id === 'workflow:release');
  assert.equal(entry?.group, 'workflows');
  assert.equal(entry?.label, 'Release');
  assert.equal(entry?.sub, 'Runs the release checklist.');
  assert.equal(entry?.workflow?.workflowKey, 'release');
  assert.equal(entry?.disabled, undefined);
});

test('broken workflow descriptors become selectable error-detail entries', () => {
  const entries = assembleEntries(
    ctx({
      workflowDescriptors: [
        {
          ok: false,
          workflowKey: 'broken',
          reason: 'artifact_load_failed',
          diagnostic: 'winner: /roots/extra/broken\nshadowed: /data/workflows/broken',
        },
      ],
    }),
  );

  const entry = entries.find((candidate) => candidate.id === 'workflow:broken');
  assert.equal(entry?.group, 'workflows');
  assert.equal(entry?.label, 'broken');
  assert.equal(entry?.tone, 'error');
  assert.equal(entry?.disabled, undefined);
  assert.equal(entry?.workflow, undefined);
  assert.equal(entry?.sub, paletteCopy.workflows.failure.broken.sub);

  const content = errorOutcome(entry);
  assert.equal(content.title, paletteCopy.workflows.failure.broken.title);
  assert.equal(content.body, workflowLoadFailureReasonCopy('artifact_load_failed'));
  assert.deepEqual(content.diagnostic, {
    label: 'Diagnostic',
    detail: 'winner: /roots/extra/broken\nshadowed: /data/workflows/broken',
  });
});

test('a broken descriptor without a diagnostic omits the detail block', () => {
  const entries = assembleEntries(
    ctx({ workflowDescriptors: [{ ok: false, workflowKey: 'broken', reason: 'missing_build' }] }),
  );
  const content = errorOutcome(entries.find((candidate) => candidate.id === 'workflow:broken'));
  assert.equal(content.diagnostic, undefined);
});

test('healthy and broken descriptors coexist as distinct row kinds', () => {
  const entries = assembleEntries(
    ctx({
      workflowDescriptors: [
        { ok: true, workflowKey: 'release', manifest: { title: 'Release' } },
        { ok: false, workflowKey: 'broken', reason: 'stale_source' },
      ],
    }),
  );

  const healthy = entries.find((candidate) => candidate.id === 'workflow:release');
  const broken = entries.find((candidate) => candidate.id === 'workflow:broken');
  assert.equal(healthy?.tone, undefined);
  assert.equal(healthy?.workflow?.workflowKey, 'release');
  assert.equal(broken?.tone, 'error');
  assert.equal(broken?.workflow, undefined);
});

test('every load-failure reason maps to non-empty reason-specific body copy', () => {
  for (const reason of workflowLoadFailureReasonSchema.literals) {
    const entries = assembleEntries(
      ctx({ workflowDescriptors: [{ ok: false, workflowKey: 'x', reason }] }),
    );
    const content = errorOutcome(entries.find((candidate) => candidate.id === 'workflow:x'));
    assert.ok(content.body && content.body.length > 0, `missing body copy for ${reason}`);
    assert.equal(content.body, workflowLoadFailureReasonCopy(reason));
  }
});

test('a workflow discovery failure replaces descriptor rows but not other groups', () => {
  const entries = assembleEntries(
    ctx({
      workflowDescriptors: [{ ok: true, workflowKey: 'release', manifest: { title: 'Release' } }],
      workflowFailure: {
        label: "Workflows couldn't be scanned.",
        sub: 'Select for details.',
        content: {
          title: "Workflows couldn't be scanned.",
          body: "Isagi couldn't read one of the workflow source paths.",
          diagnostic: {
            label: 'Diagnostic',
            detail: '/roots/missing · request req_123 · workflow_discovery_failed',
          },
        },
      },
    }),
  );

  const workflowEntries = entries.filter((entry) => entry.group === 'workflows');
  assert.equal(workflowEntries.length, 1);
  assert.equal(workflowEntries[0]?.id, 'workflow-failure');
  assert.equal(workflowEntries[0]?.tone, 'error');
  assert.equal(
    entries.find((entry) => entry.id === 'workflow:release'),
    undefined,
  );
  // Unrelated groups still assemble alongside the failure row.
  assert.ok(entries.some((entry) => entry.id === 'delete-active-worktree'));
});

test('workflowFailureEntry builds a selectable, non-launchable error row', () => {
  const entry = workflowFailureEntry({
    id: 'workflow-failure',
    label: "Couldn't load workflows.",
    sub: 'Select for details.',
    content: { title: "Couldn't load workflows.", body: 'transport failed' },
  });

  assert.equal(entry.tone, 'error');
  assert.equal(entry.group, 'workflows');
  assert.equal(entry.disabled, undefined);
  assert.equal(entry.workflow, undefined);
  assert.equal(entry.command, undefined);
  assert.equal(errorOutcome(entry).body, 'transport failed');
});

test('workflow entries are disabled while the active surface is occupied', () => {
  const entries = assembleEntries(
    ctx({
      workflowDescriptors: [
        {
          ok: true,
          workflowKey: 'release',
          manifest: { title: 'Release' },
        },
      ],
      activeSurfaceWorkflowSummary: {
        runId: 99,
        rootRunId: 99,
        parentRunId: null,
        workflowKey: 'current',
        title: 'Current workflow',
        status: 'done',
        paused: false,
        waitKind: null,
        blockingWait: null,
        worktreeId: 10,
        surfaceId: 42,
      },
    }),
  );

  const entry = entries.find((candidate) => candidate.id === 'workflow:release');
  assert.deepEqual(entry?.disabled, { reason: 'Dismiss the current workflow first.' });
  assert.equal(entry?.sub, 'Dismiss the current workflow first.');
});

// Error-detail rows define their behavior through `run()`, which returns a
// synchronous error `CommandOutcome`. This unwraps it and fails loudly if a row
// is ever wired to launch (void), resolve async, or return a non-error outcome.
function errorOutcome(entry: PaletteEntry | undefined): CommandErrorContent {
  const outcome = entry?.run();
  if (!outcome || outcome instanceof Promise || outcome.kind !== 'error') {
    throw new Error('expected a synchronous error outcome');
  }
  return outcome.content;
}

function ctx(options: Partial<PaletteContext> = {}): PaletteContext {
  return {
    projects: [],
    activeProject: {
      id: 1,
      name: 'isagi',
      rootPath: '/repo/isagi',
      glyph: 'IS',
      accent: 'blue',
      status: 'present',
      worktrees: [],
    },
    activeWorktree: {
      id: 11,
      projectId: 1,
      title: 'feature/delete-me',
      path: '/repo/isagi-feature',
      branch: 'feature/delete-me',
      head: 'abcdef0',
      isRoot: false,
      attention: 'idle',
      parked: false,
      surfaces: [{ id: 42, title: 'Main', paneKinds: [], attention: 'idle' }],
      activeSurfaceId: 42,
    },
    activeSurface: { id: 42, title: 'Main', paneKinds: [], attention: 'idle' },
    activePaneId: null,
    launchableHarnesses: [],
    ...options,
  };
}
