import { isWorkflowBranded, workflowWaitKinds } from '@yourtechbudstudio/isagi-workflow-sdk';

import { pureFailure, type PureResult } from '../state/pure.js';
import { isPlainObject } from '../state/reducers.js';
import type { WaitDeclaration } from '../types.js';

/**
 * What an operation callback handed back, checked before anything is durably recorded.
 *
 * The whole validated result is what gets saved as the segment's producer operand — not just its
 * update. For a `suspend`, a later re-reduction has to commit the same wait declaration alongside
 * the re-reduced state, and neither the discriminant nor the wait can be reconstructed from an
 * update alone.
 *
 * Recognition is by contract brand rather than by `instanceof`: a bundle embeds its own copy of the
 * SDK, so the result object a callback returns was never constructed by the runtime's instance.
 */
export type ValidatedResult =
  | { readonly type: 'complete'; readonly update: unknown }
  | { readonly type: 'suspend'; readonly update: unknown; readonly wait: WaitDeclaration };

export function validateOperationResult(value: unknown): PureResult<ValidatedResult> {
  if (!isWorkflowBranded(value, 'operation-result')) {
    return pureFailure(
      'node_callback_failed',
      'An operation callback must return complete() or suspend() from the workflow SDK.',
    );
  }
  const result = value as {
    readonly type?: unknown;
    readonly update?: unknown;
    readonly wait?: unknown;
  };
  const update = result.update;

  if (result.type === 'complete') return { ok: true, value: { type: 'complete', update } };
  if (result.type !== 'suspend') {
    return pureFailure(
      'node_callback_failed',
      `An operation result must be 'complete' or 'suspend'; received '${String(result.type)}'.`,
    );
  }

  const wait = validateWaitDeclaration(result.wait);
  if (!wait.ok) return wait;
  return { ok: true, value: { type: 'suspend', update, wait: wait.value } };
}

/**
 * A wait declaration, checked structurally.
 *
 * The *ownership* half — that every headless handle names an operation of this execution — is
 * checked by the segment, because only it knows which execution is running. Splitting them keeps
 * this function pure and reusable by the wait reconciler, which re-reads the same shape back out of
 * storage.
 */
export function validateWaitDeclaration(value: unknown): PureResult<WaitDeclaration> {
  if (!isPlainObject(value)) {
    return pureFailure('node_callback_failed', 'A suspending result must declare a wait.');
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !(workflowWaitKinds as readonly string[]).includes(kind)) {
    return pureFailure(
      'node_callback_failed',
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
          'node_callback_failed',
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
        return pureFailure(
          'node_callback_failed',
          'A user-input wait must declare at least one question.',
        );
      }
      return { ok: true, value: value as unknown as WaitDeclaration };
    }
    case 'headless_agent': {
      const operations = value.operations;
      if (!Array.isArray(operations) || operations.length === 0) {
        return pureFailure(
          'node_callback_failed',
          'A headless-agent wait must declare at least one operation.',
        );
      }
      for (const handle of operations) {
        if (!isPlainObject(handle) || typeof handle.operationId !== 'string') {
          return pureFailure(
            'node_callback_failed',
            'Each headless-agent wait member must be a handle returned by ctx.runHeadlessAgent.',
          );
        }
      }
      return { ok: true, value: value as unknown as WaitDeclaration };
    }
    default:
      return pureFailure('node_callback_failed', `Unsupported wait kind '${kind}'.`);
  }
}

/** The operation keys a headless wait is waiting on, in the author's declared order. */
export function headlessHandlesOf(wait: WaitDeclaration): readonly string[] {
  return wait.kind === 'headless_agent' ? wait.operations.map((handle) => handle.operationId) : [];
}
