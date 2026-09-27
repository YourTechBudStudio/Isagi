# Capture workflow evidence

Capture selected material a later reader needs: review responses, plans, decisions, verification results, or generated artifacts. Use `log` for diagnostics and `setUiFeedback` for progress. A captured report preserves its claims; it does not prove them.

## Capture and attribute

In an operation, `ctx.captureEvidence({ title, role, labels?, content, source? })` returns `{ evidenceId }`. The runtime adds execution, attempt, version, and time. Retain the reference in state only when later work needs it; use labels such as `{ phase, round }` to group repeated captures. Exact input constraints are in the installed SDK's `evidence.d.ts`.

| Content | Use |
| --- | --- |
| `{ kind: 'text', text, mediaType? }` | Text; defaults to `text/plain`. |
| `{ kind: 'json', value }` | JSON-serializable data. |
| `{ kind: 'file', path, mediaType? }` | Regular file within the destination, relative to `ctx.worktreePath`. |
| `{ kind: 'bytes', bytes, mediaType }` | Binary data as `Uint8Array` or `Buffer`; media type required. |

File captures preserve bytes after the source changes or disappears. For HTML, specify `text/html`; for images, use files or bytes with an image media type.

Prefer a retained source handle: `{ kind: 'agent_turn', target }` from spawn/send, or `{ kind: 'headless_operation', operation }` from headless launch. `{ kind: 'agent_session', agentSessionId }` provides only inferred attribution to this run's latest matching submission. Omitted source means no attribution; an unmatched valid handle is unresolved. Exact attribution links the supplied operation, not independently verified byte origin. Use Isagi handles, not native session IDs.

## Preserve the input before judgment

After a successful turn, select its complete assistant response across messages and parts. Commit that text in an observation node, then capture and judge the saved text in subsequent nodes. This keeps judgment input equal to evidence even if capture succeeds and its callback fails before returning.

The containing graph routes `observe → capture → judge`, retains the turn target as `reviewer`, initializes `pending` and `evidenceId` to null, and registers replacement reducers. Supply `selectResponse` to reject unavailable content and select the complete response. Route the judgment's wait result explicitly.

```ts
import {
  complete, operation, suspend, wait,
  type AgentTurnTarget, type WorkflowConversationMessage,
} from '@yourtechbudstudio/isagi-workflow-sdk';

type ReviewState = {
  readonly reviewer: AgentTurnTarget;
  readonly round: number;
  readonly pending: string | null;
  readonly evidenceId: string | null;
};

export function reviewSteps(
  selectResponse: (messages: readonly WorkflowConversationMessage[]) => string,
) {
  return {
    observe: operation<ReviewState, ReviewState>(async (ctx, state) => {
      const messages = await ctx.getConversationHistory(state.reviewer.agentSessionId);
      return complete({ update: { pending: selectResponse(messages) } });
    }),
    capture: operation<ReviewState, ReviewState>(async (ctx, state) => {
      if (state.pending === null) throw new Error('Missing review input');
      const evidence = await ctx.captureEvidence({
        title: `Review round ${state.round}`,
        role: 'review-feedback',
        labels: { round: state.round },
        content: { kind: 'text', text: state.pending },
        source: { kind: 'agent_turn', target: state.reviewer },
      });
      return complete({ update: { evidenceId: evidence.evidenceId } });
    }),
    judge: operation<ReviewState, ReviewState>(async (ctx, state) => {
      if (state.pending === null) throw new Error('Missing review input');
      const judgment = await ctx.runHeadlessAgent({
        harness: 'claude',
        prompt: `Does this review approve the work?\n\n${state.pending}`,
      });
      return suspend({ update: { pending: null }, wait: wait.headlessAgent(judgment) });
    }),
  };
}
```

Clear temporary text after its consumer commits. Keep durable evidence collections as references rather than growing response arrays in graph state.

## Retry and deliberate recapture

A completed capture at the same recorded call position returns the original `evidenceId`; it does not replace bytes. Metadata, source, content kind, media type, and file path identify the request; bytes do not. Derive metadata from stable state and retained handles. Changing the recorded request fails with `operation_request_changed`.

To evaluate a newer response, use a later visit that observes, captures, and judges again. If a file capture failed after recording intent, restore the file at its original path before Retry. A capture whose intent exists but no evidence committed can complete on re-entry. General recovery rules are in [Workflow recovery](workflow-recovery.md).

## Retrieve or diagnose

Use [CLI investigation](cli-investigate-runs.md#evidence-and-checkpoints) to list, read, or export selected content. SDK `evidenceId` is CLI `evidenceKey`. Follow `source.operationKey` for the producer's harness/model/session provenance; the record's top-level `operationKey` identifies capture itself. Unknown usage/model remains unknown, and native transcripts may disappear independently of captured evidence.

For `evidence_capture_rejected`, inspect `detail.reason` and the failed attempt: repair invalid metadata/content or a missing/outside/non-regular source file. `workflow_evidence_not_found` means no record; `workflow_evidence_content_unavailable` means saved bytes are missing or corrupt, while metadata remains inspectable.

There is no automatic retention cap. Cancellation, surface detachment, and worktree removal preserve evidence. Explicit project deletion is the separate retention boundary; retained metadata is never a guarantee that bytes remain available. Capture only material worth retaining.
