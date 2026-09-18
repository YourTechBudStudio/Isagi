import type {
  WorkflowExecutionDto,
  WorkflowFrameDto,
  WorkflowGraphDescriptorDto,
  WorkflowOperationDto,
  WorkflowStructureDescriptorDto,
} from '@isagi/contracts';

import { emptyRunState, type WorkflowRunState } from '../../../lib/workspace/workflow/model.js';
import {
  workflowExecutionFixture,
  workflowFrameFixture,
  workflowSummaryFixture,
} from '../../../lib/workspace/workflow/test-support.js';

/**
 * Inspector fixtures: a descriptor, and a projection assembled from real DTOs.
 *
 * Built with the same shapes the runtime sends rather than hand-shaped objects, so a test that
 * passes here is a test against the contract the product actually receives.
 */

export function graphFixture(
  overrides: Partial<WorkflowGraphDescriptorDto> & { readonly key: string },
): WorkflowGraphDescriptorDto {
  return {
    title: overrides.key,
    stateFields: ['draft'],
    entry: 'start',
    nodes: [],
    edges: [],
    outcomes: [],
    ...overrides,
  };
}

export function descriptorFixture(
  graphs: readonly WorkflowGraphDescriptorDto[],
  rootGraphKey = graphs[0]?.key ?? 'root',
): WorkflowStructureDescriptorDto {
  return { descriptorVersion: 1, workflowContractVersion: 3, rootGraphKey, graphs };
}

export function runStateFixture(input: {
  readonly runId?: number;
  readonly executions?: readonly WorkflowExecutionDto[];
  readonly frames?: readonly WorkflowFrameDto[];
  readonly operations?: readonly WorkflowOperationDto[];
  readonly summary?: ReturnType<typeof workflowSummaryFixture> | undefined;
  readonly hydrationEpoch?: number;
}): WorkflowRunState {
  const runId = input.runId ?? 1;
  const executions = new Map((input.executions ?? []).map((row) => [row.executionId, row]));
  const ordered = [...executions.values()].sort((left, right) =>
    left.startedAt === right.startedAt
      ? left.executionId - right.executionId
      : left.startedAt < right.startedAt
        ? -1
        : 1,
  );
  return {
    ...emptyRunState(runId),
    summary: input.summary ?? workflowSummaryFixture({ runId }),
    executions,
    executionOrder: ordered.map((row) => row.executionId),
    frames: new Map((input.frames ?? [rootFrame()]).map((row) => [row.frameId, row])),
    operations: new Map((input.operations ?? []).map((row) => [row.operationKey, row])),
    hydrated: true,
    coverageRevision: 1,
    hydrationEpoch: input.hydrationEpoch ?? 1,
  };
}

export function rootFrame(overrides: Partial<WorkflowFrameDto> = {}): WorkflowFrameDto {
  return workflowFrameFixture({ frameId: 1, graphKey: 'root', ...overrides });
}

/** A child frame plus the subgraph visit that opened it, which is how nesting is actually recorded. */
export function nested(input: {
  readonly parentExecutionId: number;
  readonly frameId: number;
  readonly graphKey: string;
  readonly parentFrameId: number;
  readonly depth: number;
  readonly frame?: Partial<WorkflowFrameDto>;
}): WorkflowFrameDto {
  return workflowFrameFixture({
    frameId: input.frameId,
    parentExecutionId: input.parentExecutionId,
    parentFrameId: input.parentFrameId,
    graphKey: input.graphKey,
    depth: input.depth,
    ...input.frame,
  });
}

export function visit(overrides: Partial<WorkflowExecutionDto>): WorkflowExecutionDto {
  return workflowExecutionFixture(overrides);
}

export const instant = (seconds: number): string =>
  new Date(Date.parse('2026-09-15T10:00:00.000Z') + seconds * 1000).toISOString();

export const clockAt = (seconds: number): number =>
  Date.parse('2026-09-15T10:00:00.000Z') + seconds * 1000;
