import { isWorkflowBranded, workflowWaitKinds } from '@yourtechbudstudio/isagi-workflow-sdk';

import { pureFailure, type PureResult } from '../state/pure.js';
import { isPlainObject } from '../state/reducers.js';
import type { WaitDeclaration } from '../types.js';

/**
 * What a node function handed back, checked before it is saved.
 *
 * The whole result is saved on the execution — the update and, for a `suspend`, the wait — because
 * it is the one value a Retry reuses, and its update is applied only once the event arrives.
 *
 * Recognition is by contract brand rather than by `instanceof`: a bundle embeds its own copy of the
 * SDK, so the result object a callback returns was never constructed by the runtime's instance.
 */
/** `update` is absent when the node changed nothing, so the saved JSON never holds `undefined`. */
export type SavedResult =
  | {
      readonly type: 'complete';
      readonly update?: unknown;
      /** Set by a checkpoint node's capture: the checkpoint it saved. */
      readonly checkpointId?: number;
    }
  | { readonly type: 'suspend'; readonly update?: unknown; readonly wait: WaitDeclaration };

export function validateOperationResult(value: unknown): PureResult<SavedResult> {
  if (!isWorkflowBranded(value, 'operation-result')) {
    return pureFailure(
      'An operation callback must return complete() or suspend() from the workflow SDK.',
    );
  }
  const result = value as {
    readonly type?: unknown;
    readonly update?: unknown;
    readonly wait?: unknown;
  };
  const update = result.update === undefined ? {} : { update: result.update };

  if (result.type === 'complete') return { ok: true, value: { type: 'complete', ...update } };
  if (result.type !== 'suspend') {
    return pureFailure(
      `An operation result must be 'complete' or 'suspend'; received '${String(result.type)}'.`,
    );
  }

  const wait = validateWaitDeclaration(result.wait);
  if (!wait.ok) return wait;
  return { ok: true, value: { type: 'suspend', ...update, wait: wait.value } };
}

/**
 * A wait declaration, checked structurally. That every headless handle names an operation of this
 * run is checked by the engine, which knows the run.
 */
export function validateWaitDeclaration(value: unknown): PureResult<WaitDeclaration> {
  if (!isPlainObject(value)) {
    return pureFailure('A suspending result must declare a wait.');
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !(workflowWaitKinds as readonly string[]).includes(kind)) {
    return pureFailure(
      `A wait must declare one of ${workflowWaitKinds.join(', ')}; received '${String(kind)}'.`,
    );
  }

  switch (kind) {
    case 'agent_turn': {
      const target = value.target;
      if (
        !isPlainObject(target) ||
        typeof target.agentSessionId !== 'number' ||
        typeof target.sentAt !== 'string'
      ) {
        return pureFailure(
          'An agent-turn wait must name the session and the submission it is waiting on.',
        );
      }
      return { ok: true, value: value as unknown as WaitDeclaration };
    }
    case 'user_continue':
      return {
        ok: true,
        value: {
          kind: 'user_continue',
          ...(typeof value.label === 'string' ? { label: value.label } : {}),
        },
      };
    case 'user_input': {
      if (!Array.isArray(value.questions) || value.questions.length === 0) {
        return pureFailure('A user-input wait must declare at least one question.');
      }
      return { ok: true, value: value as unknown as WaitDeclaration };
    }
    case 'headless_agent': {
      const operations = value.operations;
      if (!Array.isArray(operations) || operations.length === 0) {
        return pureFailure('A headless-agent wait must declare at least one operation.');
      }
      for (const handle of operations) {
        if (!isPlainObject(handle) || typeof handle.operationId !== 'string') {
          return pureFailure(
            'Each headless-agent wait member must be a handle returned by ctx.runHeadlessAgent.',
          );
        }
      }
      return { ok: true, value: value as unknown as WaitDeclaration };
    }
    default:
      return pureFailure(`Unsupported wait kind '${kind}'.`);
  }
}
