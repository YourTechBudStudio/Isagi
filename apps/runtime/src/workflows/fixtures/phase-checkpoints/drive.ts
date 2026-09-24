import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';

import type {
  WorkflowCheckpointInventoryEntry,
  WorkflowCheckpointSummaryDto,
  WorkflowExecutionDto,
} from '@isagi/contracts';

import { createFixtureWorkspace } from '../../../git/tests/fixtures.js';
import type { EngineHarness } from '../../engine/test-support.js';
import type { AnyWorkflowDefinition } from '../../structure/loader.js';
import { projectionOf } from '../drive.js';
import { makePhaseCheckpointsWorkflow, type PhaseCheckpointsVariant } from './index.js';

/** Publishes one version of the fixture and makes it the one discovery returns. */
export function publishPhaseCheckpoints(
  harness: EngineHarness,
  variant: PhaseCheckpointsVariant = {},
  version = '1',
): string {
  const artifactHash = harness.publish({
    workflowKey: 'phase-checkpoints',
    version,
    definition: makePhaseCheckpointsWorkflow(variant) as unknown as AnyWorkflowDefinition,
  });
  harness.setCurrent('phase-checkpoints', version);
  return artifactHash;
}

/**
 * Makes the harness's default destination a real Git repository with one commit, and returns that
 * commit. The harness registers it as a Git project, so capture reads a real HEAD and base tree.
 *
 * Git runs isolated from the machine's own configuration, exactly as the capture tests run it.
 */
export function initDestinationRepository(harness: EngineHarness): {
  readonly head: string;
  readonly cleanup: () => void;
} {
  const workspace = createFixtureWorkspace('phase-checkpoints');
  const repo = harness.fixture.worktreeDirectory;
  const git = (args: readonly string[]) => workspace.git(repo, args);
  git(['init']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'base']);
  return { head: git(['rev-parse', 'HEAD']).trim(), cleanup: workspace.cleanup };
}

function read<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

/** The run's checkpoints through the production read, oldest first, every page. */
export async function listAllCheckpoints(
  harness: EngineHarness,
  runId: number,
): Promise<WorkflowCheckpointSummaryDto[]> {
  const projection = projectionOf(harness);
  const items: WorkflowCheckpointSummaryDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(
      projection.listCheckpoints(runId, { limit: 2, ...(cursor ? { cursor } : {}) }),
    );
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

/** One checkpoint's final state through the production read, every page. */
export async function listAllInventory(
  harness: EngineHarness,
  runId: number,
  checkpointId: string,
): Promise<WorkflowCheckpointInventoryEntry[]> {
  const projection = projectionOf(harness);
  const entries: WorkflowCheckpointInventoryEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(
      projection.listCheckpointInventory(runId, checkpointId, {
        limit: 3,
        ...(cursor ? { cursor } : {}),
      }),
    );
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}

/** The saved bytes of one inventory file, through the production content read. */
export async function fileText(
  harness: EngineHarness,
  runId: number,
  checkpointId: string,
  fileId: string,
): Promise<string> {
  const response = await read(
    projectionOf(harness).openCheckpointFileContent(runId, checkpointId, fileId),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of response.stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** Every visit of the run as the read model projects it, `checkpoint` summary included. */
export async function executionsOf(
  harness: EngineHarness,
  runId: number,
): Promise<readonly WorkflowExecutionDto[]> {
  return (await read(projectionOf(harness).listRunExecutions(runId, { limit: 500 }))).items;
}

/** How many checkpoint rows the run has, read from storage. */
export function checkpointRowCount(harness: EngineHarness, runId: number): number {
  return (
    harness.fixture.client
      .prepare('SELECT count(*) AS n FROM workflow_checkpoints WHERE run_id = ?')
      .get(runId) as { n: number }
  ).n;
}
