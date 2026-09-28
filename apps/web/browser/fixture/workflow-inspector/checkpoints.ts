import type {
  WorkflowCheckpointDto,
  WorkflowCheckpointFileDto,
  WorkflowCheckpointScopeDto,
  WorkflowCheckpointSummaryDto,
  WorkflowExecutionSummaryDto,
  WorkflowGraphInvocationDto,
  WorkflowStructureDescriptorDto,
} from '@isagi/contracts';

/**
 * A run that saved checkpoints, and everything the checkpoint routes answer about them.
 *
 * Its own world rather than nodes added to the release check, because the release check's shape is
 * what the other inspector specs measure. A loop saves the phase three times: a small capture, a
 * full one, and one that failed and saved nothing. The full one's files cover every presentation
 * the viewer chooses between, one file whose bytes are gone, one whose first read fails in transit,
 * a file scope, and a directory scope that did not exist when it was taken.
 */

export const CHECKPOINT_ROOT_GRAPH = 'implement-story';
export const CHECKPOINT_PIN = 'sha256:c4ec0b1fixturecheckpoints';
export const CHECKPOINT_SMALL = 1;
export const CHECKPOINT_FULL = 2;
export const CHECKPOINT_SMALL_EXECUTION = 202;
export const CHECKPOINT_FULL_EXECUTION = 203;
export const CHECKPOINT_FAILED_EXECUTION = 204;

const createdBase = Date.now() - 120_000;
const at = (seconds: number) => new Date(createdBase + seconds * 1000).toISOString();

export const checkpointDescriptor: WorkflowStructureDescriptorDto = {
  descriptorVersion: 1,
  workflowContractVersion: 4,
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

/* ── saved bytes ───────────────────────────────────────────────────────────────────────────── */

export type CheckpointBytes =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'base64'; readonly base64: string }
  | { readonly kind: 'unavailable' };

const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Carries a script that must never run: an `<img>` renders SVG without executing it.
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><script>window.svgRan = true</script><rect width="24" height="16" fill="#91d7e3"/></svg>';
// Carries a script that must never run: the render preview is a sandboxed frame.
const html =
  '<!doctype html><script>parent.htmlRan = true; window.htmlRan = true</script><h1 id="report">Report</h1>';
const bigText = `# Program design\n\n${'What program design settles beyond the architecture. '.repeat(6000)}`;

interface SavedFile {
  readonly path: string;
  readonly bytes: CheckpointBytes;
  readonly executable?: boolean;
}

const designFiles: readonly SavedFile[] = [
  {
    path: 'scratch/story/design/architecture.md',
    bytes: { kind: 'text', text: '# Architecture\n\nOne checkpoint per phase.\n' },
  },
  { path: 'scratch/story/design/program-design.md', bytes: { kind: 'text', text: bigText } },
  { path: 'scratch/story/design/state-diagram.svg', bytes: { kind: 'text', text: svg } },
  { path: 'scratch/story/design/shot.png', bytes: { kind: 'base64', base64: pngBase64 } },
];

const planningFiles: readonly SavedFile[] = [
  {
    path: 'scratch/story/planning/tasks.json',
    bytes: { kind: 'text', text: '{"phase":2,"tasks":["column","files tab"]}' },
  },
  { path: 'scratch/story/planning/report.html', bytes: { kind: 'text', text: html } },
  {
    path: 'scratch/story/planning/run.sh',
    bytes: { kind: 'text', text: '#!/bin/sh\necho phase\n' },
    executable: true,
  },
  // Readable, but its first read fails in transit: a failed read, not lost bytes.
  {
    path: 'scratch/story/planning/notes.md',
    bytes: { kind: 'text', text: '# Notes\n\nRead on the second try.\n' },
  },
  // Saved and listed, and the store can no longer serve it.
  { path: 'scratch/story/planning/gone.md', bytes: { kind: 'unavailable' } },
];

const decisionsFile: SavedFile = {
  path: 'scratch/story/decisions.md',
  bytes: { kind: 'text', text: '# Decisions\n\n- Keep the tree expanded.\n' },
};

const smallFiles: readonly SavedFile[] = [
  {
    path: 'scratch/story/design/architecture.md',
    bytes: { kind: 'text', text: '# Architecture\n\nFirst draft.\n' },
  },
];

function fileRecord(file: SavedFile): WorkflowCheckpointFileDto {
  const size =
    file.bytes.kind === 'text'
      ? new TextEncoder().encode(file.bytes.text).byteLength
      : file.bytes.kind === 'base64'
        ? atob(file.bytes.base64).length
        : 2048;
  return {
    path: file.path,
    sha256: (file.path.length % 2 === 0 ? 'ab' : 'cd').repeat(32),
    sizeBytes: size,
    executable: file.executable ?? false,
  };
}

function scope(
  name: string,
  kind: WorkflowCheckpointScopeDto['kind'],
  path: string,
  files: readonly SavedFile[],
  missing = false,
): WorkflowCheckpointScopeDto {
  return { scope: name, kind, path, exclude: [], missing, files: files.map(fileRecord) };
}

const checkpoints: ReadonlyMap<number, WorkflowCheckpointDto> = new Map([
  [
    CHECKPOINT_SMALL,
    {
      checkpointId: CHECKPOINT_SMALL,
      runId: 0,
      executionId: CHECKPOINT_SMALL_EXECUTION,
      title: 'Phase 1',
      commitSha: '9e02b17'.padEnd(40, '0'),
      createdAt: at(10),
      scopes: [scope('design', 'directory', 'scratch/story/design', smallFiles)],
    },
  ],
  [
    CHECKPOINT_FULL,
    {
      checkpointId: CHECKPOINT_FULL,
      runId: 0,
      executionId: CHECKPOINT_FULL_EXECUTION,
      title: 'Phase 2',
      commitSha: 'a41c9e2'.padEnd(40, '0'),
      createdAt: at(40),
      scopes: [
        scope('design', 'directory', 'scratch/story/design', designFiles),
        scope('implementation', 'directory', 'scratch/story/planning', planningFiles),
        scope('decisions', 'file', 'scratch/story/decisions.md', [decisionsFile]),
        // Not there when the checkpoint was taken: an export makes it absent.
        scope('reviews', 'directory', 'scratch/story/reviews', [], true),
      ],
    },
  ],
]);

const bytesByKey: ReadonlyMap<string, CheckpointBytes> = new Map([
  ...smallFiles.map((file) => [`${CHECKPOINT_SMALL}:${file.path}`, file.bytes] as const),
  ...[...designFiles, ...planningFiles, decisionsFile].map(
    (file) => [`${CHECKPOINT_FULL}:${file.path}`, file.bytes] as const,
  ),
]);

/** Files whose next content read fails before any response, once. Reset with each page load. */
const failNextRead = new Set([`${CHECKPOINT_FULL}:scratch/story/planning/notes.md`]);

/* ── the run ───────────────────────────────────────────────────────────────────────────────── */

export function checkpointInvocations(): readonly Partial<WorkflowGraphInvocationDto>[] {
  return [
    {
      invocationId: 1,
      graphKey: CHECKPOINT_ROOT_GRAPH,
      depth: 0,
      status: 'running',
      state: { phase: 3 },
      startedAt: at(0),
    },
  ];
}

interface CheckpointStep {
  readonly summary: Partial<WorkflowExecutionSummaryDto> & {
    readonly executionId: number;
    readonly invocationId: number;
    readonly nodeId: string;
    readonly startedAt: string;
  };
  readonly result?: unknown;
}

export function checkpointExecutions(): readonly CheckpointStep[] {
  const common = { invocationId: 1, artifactHash: CHECKPOINT_PIN } as const;
  return [
    {
      summary: {
        ...common,
        executionId: 201,
        nodeId: 'plan',
        status: 'completed',
        routedTo: 'savePhase',
        startedAt: at(1),
        endedAt: at(5),
      },
    },
    {
      summary: {
        ...common,
        executionId: CHECKPOINT_SMALL_EXECUTION,
        nodeId: 'savePhase',
        nodeKind: 'checkpoint',
        visitIndex: 0,
        label: 'Phase 1',
        status: 'completed',
        checkpointId: CHECKPOINT_SMALL,
        routedTo: 'plan',
        startedAt: at(9),
        endedAt: at(10),
      },
      result: { type: 'complete', update: {}, checkpointId: CHECKPOINT_SMALL },
    },
    {
      summary: {
        ...common,
        executionId: CHECKPOINT_FULL_EXECUTION,
        nodeId: 'savePhase',
        nodeKind: 'checkpoint',
        visitIndex: 1,
        label: 'Phase 2',
        status: 'completed',
        checkpointId: CHECKPOINT_FULL,
        routedTo: 'plan',
        startedAt: at(39),
        endedAt: at(40),
      },
      result: { type: 'complete', update: {}, checkpointId: CHECKPOINT_FULL },
    },
    {
      summary: {
        ...common,
        executionId: CHECKPOINT_FAILED_EXECUTION,
        nodeId: 'savePhase',
        nodeKind: 'checkpoint',
        visitIndex: 2,
        label: 'Phase 3',
        status: 'failed',
        error: {
          stage: 'checkpoint_capture',
          message: 'scope "reviews" passes through a symlink',
          graphKey: CHECKPOINT_ROOT_GRAPH,
          nodeId: 'savePhase',
        },
        startedAt: at(70),
        endedAt: at(71),
      },
      result: null,
    },
  ];
}

/* ── the routes ────────────────────────────────────────────────────────────────────────────── */

export type CheckpointRouteAnswer =
  | { readonly kind: 'json'; readonly data: unknown }
  | { readonly kind: 'bytes'; readonly body: Blob }
  | { readonly kind: 'not_found'; readonly reason: string }
  | { readonly kind: 'network_error' }
  | { readonly kind: 'content_unavailable'; readonly checkpointId: number; readonly path: string };

/**
 * Answers one checkpoint route, or null when the path is not one. `hasCheckpoints` is false for the
 * release-check worlds, which saved none.
 */
export function answerCheckpointRoute(
  runId: number,
  path: string,
  query: URLSearchParams,
  hasCheckpoints: boolean,
): CheckpointRouteAnswer | null {
  if (path === `/workflows/runs/${runId}/checkpoints`) {
    const items: WorkflowCheckpointSummaryDto[] = hasCheckpoints
      ? [...checkpoints.values()].map((checkpoint) => ({
          ...checkpoint,
          runId,
          scopes: checkpoint.scopes.map(({ files, ...rest }) => ({
            ...rest,
            fileCount: files.length,
          })),
        }))
      : [];
    return { kind: 'json', data: { items, nextCursor: null } };
  }

  const file = /^\/workflows\/checkpoints\/(\d+)\/file$/.exec(path);
  if (file) {
    const checkpointId = Number(file[1]);
    const filePath = query.get('path') ?? '';
    const key = `${checkpointId}:${filePath}`;
    const bytes = bytesByKey.get(key);
    if (!hasCheckpoints || bytes === undefined) {
      return { kind: 'not_found', reason: 'workflow_checkpoint_file_not_found' };
    }
    if (failNextRead.delete(key)) return { kind: 'network_error' };
    if (bytes.kind === 'unavailable') {
      return { kind: 'content_unavailable', checkpointId, path: filePath };
    }
    const raw =
      bytes.kind === 'text'
        ? new TextEncoder().encode(bytes.text)
        : Uint8Array.from(atob(bytes.base64), (c) => c.charCodeAt(0));
    // Always octet-stream, exactly as the real route answers: the client picks presentation by path.
    return { kind: 'bytes', body: new Blob([raw], { type: 'application/octet-stream' }) };
  }

  const detail = /^\/workflows\/checkpoints\/(\d+)$/.exec(path);
  if (detail) {
    const found = hasCheckpoints ? checkpoints.get(Number(detail[1])) : undefined;
    if (found === undefined) return { kind: 'not_found', reason: 'workflow_checkpoint_not_found' };
    return { kind: 'json', data: { checkpoint: { ...found, runId } } };
  }

  return null;
}
