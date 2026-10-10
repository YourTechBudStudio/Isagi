/**
 * The live sync: how a pushed runtime fact updates the workflow reads.
 *
 * The whole protocol is: an event arrives, it is appended to its run's event list, and the run (and
 * the execution it names, if any) is re-read once per burst. A changed summary replaces the held
 * one and the attached-run list. A reconnect re-reads every live read. The latest write wins;
 * nothing compares revisions or timestamps, so a slow re-read can briefly show an older summary
 * until the next event or re-read corrects it.
 *
 * Called by the runtime-events connection (`handleRuntimeEvent`) for each workflow fact, in arrival
 * order. It never starts a read for a run nobody holds.
 */
import { Effect, Option } from 'effect';
import { AtomRegistry } from 'effect/reactivity';

import type { WorkflowEventDto, WorkflowRunSummary } from '@isagi/contracts';

import { keys } from '../../state/keys.js';
import { patch, peek } from '../../state/policy.js';
import { replaceAttached, upsertAttached } from './attached.js';
import {
  mergeEvents,
  runtimeConnectionPhaseAtom,
  workflowLive,
  workflowResyncAtom,
  type WorkflowLive,
  type WorkflowSignal,
} from './live.js';
import { attachedRunsAtom, workflowEventsAtom, workflowRunAtom } from './queries.js';

export const receiveWorkflowSignal = Effect.fn('receiveWorkflowSignal')(function* (
  signal: WorkflowSignal,
) {
  const registry = yield* AtomRegistry.AtomRegistry;
  if (signal.type === 'disconnected') {
    // The phase is all a dropped connection changes; what was missed is re-read on `connected`.
    registry.set(runtimeConnectionPhaseAtom, 'disconnected');
    return;
  }
  const live = yield* workflowLive;
  switch (signal.type) {
    case 'connected':
      registry.set(runtimeConnectionPhaseAtom, 'connected');
      // A reconnect cannot prove nothing was missed while the socket was down, so every live read
      // re-reads (the ones on screen now, the others when next shown). Structures and saved
      // checkpoints are immutable, and the connection's snapshot refreshes the attached runs.
      registry.update(workflowResyncAtom, (count) => count + 1);
      break;
    case 'snapshot':
      // The runtime's complete answer to "which runs occupy a surface right now".
      registry.set(attachedRunsAtom, replaceAttached(signal.summaries));
      break;
    case 'run_changed':
      yield* applySummary(registry, live, signal.summary);
      break;
    case 'run_event':
      yield* applyEvent(registry, live, signal.event);
      break;
  }
  yield* live.publish(signal);
});

function applySummary(
  registry: AtomRegistry.AtomRegistry,
  live: WorkflowLive,
  summary: WorkflowRunSummary,
) {
  registry.update(attachedRunsAtom, (current) => upsertAttached(current ?? [], summary));
  const run = workflowRunAtom(summary.runId);
  const held = peek(registry, run);
  if (Option.isSome(held) && held.value._tag === 'Failure') {
    // Writing the summary would clear the failed read's error while the tree beside it is still the
    // one that failed to refresh. A successful re-read is what clears it.
    return live.refetchSoon(keys.workflowRun(summary.runId));
  }
  patch(registry, run, (detail) => ({ ...detail, run: summary }));
  return Effect.void;
}

const applyEvent = Effect.fnUntraced(function* (
  registry: AtomRegistry.AtomRegistry,
  live: WorkflowLive,
  event: WorkflowEventDto,
) {
  const events = workflowEventsAtom(event.runId);
  const held = peek(registry, events);
  if (Option.isSome(held) && held.value.waiting) {
    // A read is in flight and may already have passed this event, so it waits for that read.
    live.hold(event.runId, event);
  } else if (Option.isSome(held) && held.value._tag === 'Failure') {
    // The last read failed, so what is held is incomplete. Appending would clear that error without
    // recovering what was missed; a full re-read either succeeds (and merges this event) or keeps
    // the warning.
    live.hold(event.runId, event);
    yield* live.refetchSoon(keys.workflowEvents(event.runId));
  } else {
    // Appended to a held list. Nothing holds this run's events otherwise: the next read starts
    // from the beginning and includes it.
    patch(registry, events, (current) => mergeEvents(current, [event]));
  }

  yield* live.refetchSoon(keys.workflowRun(event.runId));
  if (event.executionId !== null) {
    yield* live.refetchSoon(keys.workflowExecution(event.executionId));
  }
  if (event.kind === 'checkpoint_captured') {
    yield* live.refetchSoon(keys.workflowCheckpoints(event.runId));
  }
});
