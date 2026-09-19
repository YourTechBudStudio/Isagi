# Capture workflow evidence

Use evidence for things a later reader needs to inspect: a reviewer's response, each review round, a plan, a verification result, a generated image, or a presentation. Capture deliberately selected outputs, not every log line, token, or intermediate variable. Use `log` for diagnostics and `setUiFeedback` for progress. Capturing a report preserves what it says; it does not establish that its claims are true.

Read [Workflow authoring](workflows.md) for graph structure and package checks, [Agent work](workflow-agents.md) for turn handling, and the installed SDK's `evidence.d.ts` for exact types.

## The verb and content kinds

Inside an operation, `await ctx.captureEvidence({ title, role, labels?, content, source? })` returns `{ evidenceId }`. Isagi records the run, frame, node visit, committing attempt, capture operation, code version, and capture time automatically. Retain the opaque `evidenceId` in state only when later work needs the reference; no author-maintained collection is required.

| `content` | What is kept |
| --- | --- |
| `{ kind: 'text', text, mediaType? }` | UTF-8 text; defaults to `text/plain` |
| `{ kind: 'json', value }` | Canonical JSON; `application/json`; value must be JSON-serializable |
| `{ kind: 'file', path, mediaType? }` | Exact file bytes; path is relative to `ctx.worktreePath`; media type defaults from the extension |
| `{ kind: 'bytes', bytes, mediaType }` | A `Uint8Array`, including a Node `Buffer`; media type is required |

For HTML, use text with `mediaType: 'text/html'` or a file capture. For images, use a file or bytes with its image media type. A file path must name a regular file inside the worktree: absolute paths, escaping traversal, and symlinks resolving outside it are refused. A successful capture survives later edits or deletion of the source file; `sourcePath` retains its normalized worktree-relative name.

Titles are trimmed, non-empty, and at most 512 characters. Roles are your vocabulary, such as `review-feedback`, `plan`, or `verification`; they match `[a-z0-9][a-z0-9._-]{0,63}`. Labels are a flat object of strings, finite numbers, or booleans, with at most 32 entries. Keys are 1–64 characters with no colon or control characters; strings are at most 1024 characters. Limits reject rather than truncate.

Use labels such as `{ phase: state.phase, round: state.round }` to group repeated visits. The run hierarchy already places each capture in its frame and visit. Label filters compare values as text: `round:2` matches both number `2` and string `"2"`. Boolean representations also collapse: `approved:true` matches JSON `true`, number `1`, string `"true"`, and string `"1"`; `approved:false` likewise matches `false`, `0`, `"false"`, and `"0"`. A numeric spelling such as `approved:1` compares only against text `"1"`, so it does not match the string `"true"`.

## Capture before judgment

Keep the target returned by `spawnAgentSession` or `sendAgentPrompt`, wait for its turn to end successfully, then read the complete assistant response. Hand back that same target as the source. Capture the response before building or launching a judgment prompt, so it is durably recorded regardless of what the judgment or later work does.

Use separate collection and judgment nodes. The collection node commits the read response as temporary `pending` input; the judgment node builds its prompt from that saved value and clears it when suspending. This makes a Retry of the judging node reproduce its recorded request instead of rereading a conversation that may have changed.

The fragment below supplies those two nodes. The containing graph routes `collect` to `judge` after a successful reviewer turn, retains the returned turn target as `reviewer`, initializes `reviewer`, `pending`, and `evidenceId` to null, and registers replacement reducers for these state fields. Supply a `selectResponse` function that selects the complete assistant response across messages and parts and rejects unavailable content.

```ts
import {
  complete,
  operation,
  suspend,
  wait,
  type AgentTurnTarget,
  type WorkflowConversationMessage,
} from '@yourtechbudstudio/isagi-workflow-sdk';

type ReviewState = {
  readonly reviewer: AgentTurnTarget | null;
  readonly round: number;
  readonly pending: string | null;
  readonly evidenceId: string | null;
};

export function reviewSteps(
  selectResponse: (messages: readonly WorkflowConversationMessage[]) => string,
) {
  return {
    collect: operation<ReviewState, ReviewState>(async (ctx, state) => {
      const reviewer = state.reviewer;
      if (reviewer === null) throw new Error('Missing reviewer target');
      const messages = await ctx.getConversationHistory(reviewer.agentSessionId);
      const response = selectResponse(messages);
      const evidence = await ctx.captureEvidence({
        title: `Review round ${state.round}`,
        role: 'review-feedback',
        labels: { round: state.round },
        content: { kind: 'text', text: response },
        source: { kind: 'agent_turn', target: reviewer },
      });
      return complete({
        update: { pending: response, evidenceId: evidence.evidenceId },
      });
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

The capture and judgment each occupy a recorded call position in their own node visit. If collection fails after capture, Retry returns the original evidence reference while the author's read may return a newer response. Once collection completes, its `pending` update is saved; Retry of `judge` uses that saved input. Clearing `pending` commits with suspension, so a judging callback that fails before returning can still be repaired with the same prompt.

Combining a conversation reread and judgment in one callback can instead produce `operation_request_changed`: if the judgment was already recorded before the callback failed, a newer response changes its recorded prompt. Commit the read input across a node boundary before judging, as above, to preserve that request on Retry.

To deliberately evaluate a newer response, route to a later node visit: read, capture again, then judge there. That visit creates a second evidence record rather than replacing the first. Use evidence references and the run's evidence listing for the lasting collection, rather than accumulating response bodies in graph state.

## Retry reuses; a later visit captures again

`captureEvidence` is a durable recorded operation, like `runHeadlessAgent`. Preserve the order of recorded calls when repairing code. Title, role, labels, and source must come from stable graph state and retained handles, never from captured content. Content kind, media type, and normalized file path also participate in the recorded request; the captured bytes do not. Changing the recorded identity is rejected as `operation_request_changed`.

A completed capture at the same call position returns the same `evidenceId`, even if a conversation reread changes or the original file is gone. Re-entry does not overwrite its bytes or append a replacement record. A later visit to the node creates new call positions and therefore new evidence, even when the metadata or bytes happen to be identical. Put a deliberate reread after a human gate or another review round in that later visit.

An `abandoned` capture means its intent was recorded but no evidence record committed; re-entry can complete that same position. A file capture that failed after intent is repaired by restoring the file at its recorded path, not by changing the path in code. See [Workflow recovery](workflow-recovery.md) for the broader distinction between reads, recorded operations, and diagnostics.

## Sources and attribution

| `source` | Meaning |
| --- | --- |
| `{ kind: 'agent_turn', target: reviewer }` | Pass the spawn/send target already retained; `exact` when its operation resolves in this run |
| `{ kind: 'headless_operation', operation: handle }` | Pass the handle returned by `runHeadlessAgent`; `exact` when it resolves in this run |
| `{ kind: 'agent_session', agentSessionId }` | Session-only attribution; `inferred_latest_operation` names this run's latest matching submission |
| Omitted | Source kind `none`; nothing is inferred |

`exact` describes the connection to the supplied operation, not an independent check of the origin of arbitrary bytes. A valid source that cannot be matched is `unresolved`; content is still captured. A malformed source is rejected. Prefer retained turn targets or headless handles over session-only inference. Never substitute a provider's native session ID for an Isagi handle.

Follow the source operation to inspect harness, requested model/effort, native session correlation, cwd, runtime identity, code version, and usage when available. Unknown values remain explicit; a send does not invent the model inherited from its session. A native transcript locator is evaluated on operation detail reads, not on list reads.

## Find, fetch, and download

The inspector's Evidence tab groups the run's captures by frame and visit. The Evidence dock column shows the selected visit and descendants on every inspector tab. Trace rows and declared nodes carry capture counts. Lists show metadata, not file availability; opening content is what discovers a missing or corrupt blob. HTML opens as source, with an opt-in isolated preview; downloads retain the captured bytes.

API consumers use these runtime routes, under `/api/v1`:

| Method and path | Result |
| --- | --- |
| `GET /workflows/runs/:runId/evidence` | Metadata-only `{ items, nextCursor }` |
| `GET /workflows/runs/:runId/evidence/:evidenceKey` | One `{ evidence }` record |
| `GET /workflows/runs/:runId/evidence/:evidenceKey/content` | Verified content bytes; add `?download=true` for attachment download |

The SDK's `evidenceId` is the API's `evidenceKey`. List queries accept `limit`, `cursor`, `frameId`, `executionId`, `subtree=true`, `role`, and repeatable `label=key:value` filters. `subtree=true` requires `executionId` and includes its child-frame executions. Filters combine; repeat a label parameter rather than comma-joining values, for example `?role=review-feedback&label=phase:1&label=round:2`. URL-encode query values and follow `nextCursor` until null.

Server-side `role`/`label` filters and the runtime client's `workflowEvidenceContentUrl(runId, evidenceKey, { download: true })` helper are API-consumer surfaces. These are not workflow `ctx` methods. Follow a record's `source.operationKey` through `GET /workflows/runs/:runId/operations/:operationKey` for source provenance; its top-level `operationKey` instead names the capture operation.

A missing record yields `workflow_evidence_not_found`. Missing or corrupt captured bytes yield `workflow_evidence_content_unavailable` with the key, content reference, and cause. Metadata remains inspectable. Do not interpret a failed content read as “nothing was captured.”

## Rejected captures

An `evidence_capture_rejected` failure carries `detail.reason`. Inspect the failed attempt and its diagnostic context before repairing it.

| Reason | What to fix |
| --- | --- |
| `invalid_title` | Missing, empty, or overlong title |
| `invalid_role` | Role outside the accepted grammar |
| `invalid_labels` | Label shape, key, value, or limit |
| `invalid_source` | Source kind or handle shape |
| `invalid_content` | Missing content, unknown kind, or wrong content field type |
| `invalid_media_type` | Missing required or invalid media type |
| `unserializable_json` | Value that cannot be represented as supported JSON |
| `path_outside_worktree` | Invalid relative path or a resolved path escaping the worktree |
| `path_not_found` | Source file absent or unresolvable |
| `not_a_file` | Source is not a regular file |
| `content_unavailable` | Bytes could not be read or published; inspect the recorded cause |

Validation can reject before a call position exists. Filesystem and publication failures can happen after intent, leaving no committed evidence record; preserve that recorded request when retrying. Capture publication and its metadata commit are distinct stages, so a failure never counts as a successful capture merely because bytes reached disk.

## Retention and limits

Evidence is retained indefinitely, with no eviction or configurable cap. Disk use grows with captured content. Bytes live in Isagi's content store, not in graph state; keep references for durable collections. A temporary state field used to pass input to the next node is working data, not the evidence store.

Native transcripts are best-effort external references. They can rotate, disappear with session cleanup, or be unreachable from another runtime. Their loss does not remove captured evidence. Capture what must remain inspectable rather than relying on a transcript locator or a mutable worktree path.
