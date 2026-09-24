import type {
  WorkflowCheckpointBase,
  WorkflowCheckpointDto,
  WorkflowCheckpointInventoryEntry,
  WorkflowCheckpointSummaryDto,
  WorkflowExecutionCheckpointDto,
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowStructureDescriptorDto,
} from '@isagi/contracts';

import {
  workflowExecutionFixture,
  workflowFrameFixture,
} from '../../../src/lib/workspace/workflow/test-support.js';

/**
 * A run that saved checkpoints, and everything the five checkpoint routes answer about them.
 *
 * Its own world rather than nodes added to the release check, because the release check's shape is
 * what the other inspector specs measure. A loop saves the phase three times: a clean capture, one
 * that left changes out and skipped a symlink, and one that failed and saved nothing. The second's
 * files cover every presentation the viewer chooses between, one file whose bytes are gone, and a
 * required absence, and its inventory is answered over two pages.
 */

export const CHECKPOINT_ROOT_GRAPH = 'implement-story';
export const CHECKPOINT_CLEAN = 'wcp_0a1b2c3d-1111-4111-8111-00000000c1ea';
export const CHECKPOINT_WARNED = 'wcp_7f3a91e0-2222-4222-8222-00000000c21e';
export const CHECKPOINT_CLEAN_EXECUTION = 202;
export const CHECKPOINT_WARNED_EXECUTION = 203;
export const CHECKPOINT_FAILED_EXECUTION = 204;

const pin = 'sha256:9f2c1abfixtureone';
const createdBase = Date.now() - 120_000;
const at = (seconds: number) => new Date(createdBase + seconds * 1000).toISOString();

const gitBase = (sha: string): WorkflowCheckpointBase => ({
  kind: 'git',
  repositoryId: 1,
  commitSha: sha.padEnd(40, '0'),
});

export const checkpointDescriptor: WorkflowStructureDescriptorDto = {
  descriptorVersion: 1,
  workflowContractVersion: 3,
  rootGraphKey: CHECKPOINT_ROOT_GRAPH,
  graphs: [
    {
      key: CHECKPOINT_ROOT_GRAPH,
      title: 'Implement story',
      stateFields: ['phase'],
      entry: 'plan',
      nodes: [
        { id: 'plan', kind: 'operation', title: 'Plan the phase' },
        { id: 'savePhase', kind: 'checkpoint', title: 'Save completed phase' },
      ],
      edges: [
        { id: 'after-plan', from: 'plan', to: ['savePhase'] },
        { id: 'toPlanning', from: 'savePhase', to: ['plan', 'shipped'] },
      ],
      outcomes: [{ id: 'shipped', kind: 'success' }],
    },
  ],
};

/* ── the two saved checkpoints ─────────────────────────────────────────────────────────────── */

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const cleanBase = gitBase('9e02b17');
const warnedBase = gitBase('a41c9e2');

const counts = {
  clean: { scopes: 1, files: 1, absences: 0, warnings: 1 },
  warned: { scopes: 3, files: 10, absences: 1, warnings: 4 },
};

const summaries: readonly WorkflowCheckpointSummaryDto[] = [
  {
    checkpointId: CHECKPOINT_CLEAN,
    runId: 77,
    frameId: 1,
    executionId: CHECKPOINT_CLEAN_EXECUTION,
    attemptId: 1,
    nodeId: 'savePhase',
    title: 'Phase 1',
    createdAt: at(10),
    base: cleanBase,
  },
  {
    checkpointId: CHECKPOINT_WARNED,
    runId: 77,
    frameId: 1,
    executionId: CHECKPOINT_WARNED_EXECUTION,
    attemptId: 1,
    nodeId: 'savePhase',
    title: 'Phase 2',
    createdAt: at(40),
    base: warnedBase,
  },
];

const details: ReadonlyMap<string, WorkflowCheckpointDto> = new Map([
  [
    CHECKPOINT_CLEAN,
    {
      ...summaries[0]!,
      parentCheckpointId: null,
      artifactHash: pin,
      provenance: { repositoryRootPath: '/work/isagi' },
      counts: counts.clean,
      warningGroups: [{ reason: 'ignored_paths_not_surveyed', count: 1, samples: [] }],
      links: { inventory: 'inventory', manifest: 'manifest' },
    },
  ],
  [
    CHECKPOINT_WARNED,
    {
      ...summaries[1]!,
      parentCheckpointId: CHECKPOINT_CLEAN,
      artifactHash: pin,
      provenance: { repositoryRootPath: '/work/isagi' },
      counts: counts.warned,
      warningGroups: [
        {
          reason: 'uncaptured_dirty_path',
          count: 3418,
          samples: [
            'apps/web/src/index.ts',
            'apps/web/src/main.tsx',
            'apps/web/src/router.ts',
            'apps/web/src/styles.css',
            'apps/web/vite.config.ts',
          ],
        },
        { reason: 'symlink_skipped', count: 1, samples: ['scratch/story/design/latest.md'] },
        { reason: 'ignored_paths_not_surveyed', count: 1, samples: [] },
      ],
      links: { inventory: 'inventory', manifest: 'manifest' },
    },
  ],
]);

export type CheckpointBytes =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'base64'; readonly base64: string }
  | { readonly kind: 'unavailable'; readonly cause: 'missing' | 'corrupt' };

const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Carries a script that must never run: an `<img>` renders SVG without executing it.
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><script>window.svgRan = true</script><rect width="24" height="16" fill="#91d7e3"/></svg>';
const bigText = `# Program design\n\n${'What program design settles beyond the architecture. '.repeat(6000)}`;

interface SavedFile {
  readonly path: string;
  readonly fileId: string;
  readonly bytes: CheckpointBytes;
  readonly executable?: boolean;
}

const warnedFiles: readonly SavedFile[] = [
  {
    path: 'scratch/story/design/architecture.md',
    fileId: 'wcf_arch',
    bytes: { kind: 'text', text: '# Architecture\n\nOne checkpoint row per visit.\n' },
  },
  {
    path: 'scratch/story/design/program-design.md',
    fileId: 'wcf_big',
    bytes: { kind: 'text', text: bigText },
  },
  {
    path: 'scratch/story/design/state-diagram.svg',
    fileId: 'wcf_svg',
    bytes: { kind: 'text', text: svg },
  },
  {
    path: 'scratch/story/design/shot.png',
    fileId: 'wcf_png',
    bytes: { kind: 'base64', base64: pngBase64 },
  },
  {
    path: 'scratch/story/planning/tasks.json',
    fileId: 'wcf_json',
    bytes: { kind: 'text', text: '{"phase":2,"tasks":["column","files tab"]}' },
  },
  {
    path: 'scratch/story/planning/report.html',
    fileId: 'wcf_html',
    bytes: {
      kind: 'text',
      text: '<!doctype html><script>window.htmlRan = true</script><h1>Report</h1>',
    },
  },
  {
    path: 'scratch/story/planning/run.sh',
    fileId: 'wcf_sh',
    bytes: { kind: 'text', text: '#!/bin/sh\necho phase\n' },
    executable: true,
  },
  // Readable, but its first read fails in transit: a failed read, not lost bytes.
  {
    path: 'scratch/story/planning/notes.md',
    fileId: 'wcf_flaky',
    bytes: { kind: 'text', text: '# Notes\n\nRead on the second try.\n' },
  },
  // Saved and listed, and the store can no longer serve it.
  {
    path: 'scratch/story/planning/gone.md',
    fileId: 'wcf_gone',
    bytes: { kind: 'unavailable', cause: 'corrupt' },
  },
  {
    path: 'scratch/story/decisions.md',
    fileId: 'wcf_decisions',
    bytes: { kind: 'text', text: '# Decisions\n\n- Keep the tree expanded.\n' },
  },
];

const cleanFiles: readonly SavedFile[] = [
  {
    path: 'scratch/story/design/architecture.md',
    fileId: 'wcf_arch_v1',
    bytes: { kind: 'text', text: '# Architecture\n\nFirst draft.\n' },
  },
];

function fileEntry(file: SavedFile): WorkflowCheckpointInventoryEntry {
  const size =
    file.bytes.kind === 'text'
      ? new TextEncoder().encode(file.bytes.text).byteLength
      : file.bytes.kind === 'base64'
        ? atob(file.bytes.base64).length
        : 2048;
  return {
    kind: 'file',
    path: file.path,
    fileId: file.fileId,
    sha256: sha(file.fileId.length % 2 === 0 ? 'ab' : 'cd'),
    sizeBytes: size,
    executable: file.executable ?? false,
  };
}

const inventories: ReadonlyMap<string, readonly WorkflowCheckpointInventoryEntry[]> = new Map([
  [
    CHECKPOINT_CLEAN,
    [
      {
        kind: 'scope',
        scopeId: 'design',
        scopeKind: 'directory',
        path: 'scratch/story/design',
        exclusions: [],
        capturedBy: CHECKPOINT_CLEAN,
      },
      ...cleanFiles.map(fileEntry),
    ],
  ],
  [
    CHECKPOINT_WARNED,
    [
      {
        kind: 'scope',
        scopeId: 'design',
        scopeKind: 'directory',
        path: 'scratch/story/design',
        exclusions: [],
        capturedBy: CHECKPOINT_WARNED,
      },
      {
        kind: 'scope',
        scopeId: 'implementation',
        scopeKind: 'directory',
        path: 'scratch/story/planning',
        exclusions: [],
        capturedBy: CHECKPOINT_WARNED,
      },
      {
        kind: 'scope',
        scopeId: 'decisions',
        scopeKind: 'file',
        path: 'scratch/story/decisions.md',
        exclusions: [],
        capturedBy: CHECKPOINT_WARNED,
      },
      ...warnedFiles.map(fileEntry),
      { kind: 'absent', path: 'scratch/story/design/obsolete.md' },
      {
        kind: 'warning',
        reason: 'symlink_skipped',
        path: 'scratch/story/design/latest.md',
        scopeId: 'design',
        detail: null,
        observedBy: CHECKPOINT_WARNED,
      },
    ],
  ],
]);

/** Files whose next content read fails before any response, once. Reset with each page load. */
const failNextRead = new Set(['wcf_flaky']);

const bytesById: ReadonlyMap<string, CheckpointBytes> = new Map(
  [...cleanFiles, ...warnedFiles].map((file) => [file.fileId, file.bytes]),
);

/* ── the run ───────────────────────────────────────────────────────────────────────────────── */

const inline = (checkpointId: string): WorkflowExecutionCheckpointDto => {
  const detail = details.get(checkpointId)!;
  return { checkpointId, title: detail.title, base: detail.base, counts: detail.counts };
};

function succeeded(attemptId: number) {
  return {
    attemptId,
    attemptIndex: 1,
    artifactHash: pin,
    status: 'succeeded',
    invocationKind: 'initial',
    failure: null,
    recoveryMode: 'rerun_producer',
    producerArtifactHash: null,
  } as const;
}

export function checkpointFrames(): readonly WorkflowFrameDto[] {
  return [
    workflowFrameFixture({
      frameId: 1,
      graphKey: CHECKPOINT_ROOT_GRAPH,
      entryArtifactHash: pin,
      depth: 0,
      status: 'active',
      enteredAt: at(0),
      executionCount: 4,
    }),
  ];
}

export function checkpointExecutions(): readonly WorkflowExecutionDto[] {
  const common = {
    frameId: 1,
    graphKey: CHECKPOINT_ROOT_GRAPH,
    attemptCount: 1,
    firstArtifactHash: pin,
    latestArtifactHash: pin,
  } as const;
  return [
    workflowExecutionFixture({
      ...common,
      executionId: 201,
      nodeId: 'plan',
      status: 'completed',
      startedAt: at(1),
      endedAt: at(5),
      callbackStartedAt: at(1),
      callbackEndedAt: at(5),
      latestAttempt: succeeded(201),
    }),
    workflowExecutionFixture({
      ...common,
      executionId: CHECKPOINT_CLEAN_EXECUTION,
      nodeId: 'savePhase',
      nodeKind: 'checkpoint',
      visitIndex: 0,
      status: 'completed',
      startedAt: at(9),
      endedAt: at(10),
      callbackStartedAt: at(9),
      callbackEndedAt: at(10),
      latestAttempt: succeeded(202),
      checkpoint: inline(CHECKPOINT_CLEAN),
    }),
    workflowExecutionFixture({
      ...common,
      executionId: CHECKPOINT_WARNED_EXECUTION,
      nodeId: 'savePhase',
      nodeKind: 'checkpoint',
      visitIndex: 1,
      status: 'completed',
      startedAt: at(39),
      endedAt: at(40),
      callbackStartedAt: at(39),
      callbackEndedAt: at(40),
      latestAttempt: succeeded(203),
      checkpoint: inline(CHECKPOINT_WARNED),
    }),
    workflowExecutionFixture({
      ...common,
      executionId: CHECKPOINT_FAILED_EXECUTION,
      nodeId: 'savePhase',
      nodeKind: 'checkpoint',
      visitIndex: 2,
      status: 'failed',
      startedAt: at(70),
      endedAt: at(71),
      callbackStartedAt: at(70),
      callbackEndedAt: at(71),
      latestAttempt: {
        ...succeeded(204),
        status: 'failed',
        failure: {
          code: 'checkpoint_capture_failed',
          message: 'scope "reviews" was scratch/reviews, now scratch/story/reviews',
          detail: { inline: { reason: 'scope_identity_changed' } },
        },
      },
      checkpoint: null,
    }),
  ];
}

/* ── the routes ────────────────────────────────────────────────────────────────────────────── */

/** Four entries a page, so the client has to follow the continuation to see the whole tree. */
const INVENTORY_PAGE = 4;

export type CheckpointRouteAnswer =
  | { readonly kind: 'json'; readonly data: unknown }
  | { readonly kind: 'bytes'; readonly body: Blob; readonly filename: string }
  | { readonly kind: 'not_found'; readonly reason: string }
  | { readonly kind: 'network_error' }
  | {
      readonly kind: 'content_unavailable';
      readonly checkpointId: string;
      readonly fileId: string;
      readonly cause: 'missing' | 'corrupt';
    };

/** Answers one checkpoint route, or null when the path is not one. */
export function answerCheckpointRoute(
  path: string,
  query: URLSearchParams,
): CheckpointRouteAnswer | null {
  if (/^\/workflows\/runs\/\d+\/checkpoints$/.test(path)) {
    return { kind: 'json', data: { items: summaries, nextCursor: null } };
  }

  const content = /^\/workflows\/runs\/\d+\/checkpoints\/([^/]+)\/files\/([^/]+)\/content$/.exec(
    path,
  );
  if (content) {
    const checkpointId = decodeURIComponent(content[1]!);
    const fileId = decodeURIComponent(content[2]!);
    const entry = inventories
      .get(checkpointId)
      ?.find((item) => item.kind === 'file' && item.fileId === fileId);
    const bytes = bytesById.get(fileId);
    if (entry === undefined || entry.kind !== 'file' || bytes === undefined) {
      return { kind: 'not_found', reason: 'workflow_checkpoint_file_not_found' };
    }
    if (failNextRead.delete(fileId)) return { kind: 'network_error' };
    if (bytes.kind === 'unavailable') {
      return { kind: 'content_unavailable', checkpointId, fileId, cause: bytes.cause };
    }
    const raw =
      bytes.kind === 'text'
        ? new TextEncoder().encode(bytes.text)
        : Uint8Array.from(atob(bytes.base64), (c) => c.charCodeAt(0));
    // Always octet-stream, exactly as the real route answers: the client picks presentation by path.
    return {
      kind: 'bytes',
      body: new Blob([raw], { type: 'application/octet-stream' }),
      filename: entry.path.split('/').at(-1)!,
    };
  }

  const inventory = /^\/workflows\/runs\/\d+\/checkpoints\/([^/]+)\/inventory$/.exec(path);
  if (inventory) {
    const checkpointId = decodeURIComponent(inventory[1]!);
    const entries = inventories.get(checkpointId);
    if (entries === undefined)
      return { kind: 'not_found', reason: 'workflow_checkpoint_not_found' };
    const offset = Number(query.get('cursor') ?? 0);
    const page = entries.slice(offset, offset + INVENTORY_PAGE);
    const next = offset + page.length;
    return {
      kind: 'json',
      data: {
        checkpointId,
        entries: page,
        nextCursor: next >= entries.length ? null : String(next),
      },
    };
  }

  const detail = /^\/workflows\/runs\/\d+\/checkpoints\/([^/]+)$/.exec(path);
  if (detail) {
    const found = details.get(decodeURIComponent(detail[1]!));
    if (found === undefined) return { kind: 'not_found', reason: 'workflow_checkpoint_not_found' };
    return { kind: 'json', data: { checkpoint: found } };
  }

  return null;
}
