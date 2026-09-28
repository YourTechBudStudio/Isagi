import type {
  WorkflowEventDto,
  WorkflowExecutionSummaryDto,
  WorkflowGraphDescriptorDto,
  WorkflowGraphInvocationDto,
  WorkflowRunSummary,
  WorkflowStructureDescriptorDto,
} from '@isagi/contracts';

import { buildRunView, type WorkflowRunView } from '../../../lib/workspace/workflow/run-view.js';
import {
  workflowExecutionFixture,
  workflowInvocationFixture,
  workflowSummaryFixture,
} from '../../../lib/workspace/workflow/test-support.js';

/**
 * Inspector fixtures: a descriptor, and a run view assembled from real DTOs.
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
  return { descriptorVersion: 1, workflowContractVersion: 4, rootGraphKey, graphs };
}

/** A run view assembled from real DTOs, exactly as `useWorkflowRunView` builds one. */
export function runViewFixture(input: {
  readonly runId?: number;
  readonly executions?: readonly WorkflowExecutionSummaryDto[];
  readonly invocations?: readonly WorkflowGraphInvocationDto[];
  readonly events?: readonly WorkflowEventDto[];
  readonly summary?: WorkflowRunSummary | undefined;
}): WorkflowRunView {
  const runId = input.runId ?? 1;
  return buildRunView(
    {
      run: input.summary ?? workflowSummaryFixture({ runId }),
      inputs: {},
      invocations: input.invocations ?? [rootInvocation()],
      executions: input.executions ?? [],
    },
    input.events ?? [],
  );
}

export function rootInvocation(
  overrides: Partial<WorkflowGraphInvocationDto> = {},
): WorkflowGraphInvocationDto {
  return workflowInvocationFixture({ invocationId: 1, graphKey: 'root', ...overrides });
}

/** A child invocation, entered by the subgraph execution that opened it. */
export function nested(input: {
  readonly parentExecutionId: number;
  readonly invocationId: number;
  readonly graphKey: string;
  readonly depth: number;
  readonly invocation?: Partial<WorkflowGraphInvocationDto>;
}): WorkflowGraphInvocationDto {
  return workflowInvocationFixture({
    invocationId: input.invocationId,
    parentExecutionId: input.parentExecutionId,
    graphKey: input.graphKey,
    depth: input.depth,
    ...input.invocation,
  });
}

export function visit(
  overrides: Partial<WorkflowExecutionSummaryDto>,
): WorkflowExecutionSummaryDto {
  return workflowExecutionFixture(overrides);
}

export const instant = (seconds: number): string =>
  new Date(Date.parse('2026-09-15T10:00:00.000Z') + seconds * 1000).toISOString();

export const clockAt = (seconds: number): number =>
  Date.parse('2026-09-15T10:00:00.000Z') + seconds * 1000;
