import type { WorkflowResult, WorkflowWaitCondition } from './types.js';

export function cont(nextState: unknown): WorkflowResult {
  return { type: 'cont', state: nextState };
}

export function suspend(nextState: unknown, condition: WorkflowWaitCondition): WorkflowResult {
  return { type: 'suspend', state: nextState, condition };
}

export function done(): WorkflowResult {
  return { type: 'done' };
}
