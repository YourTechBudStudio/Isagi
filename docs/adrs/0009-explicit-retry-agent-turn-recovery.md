# 0009-explicit-retry-agent-turn-recovery

status: accepted
date: 2026-09-13

## Decision

Explicit workflow Retry authorizes the runtime to accept the latest observed turn in the same durable agent session when replaying a failed agent-response step. The replacement turn need not have the original prompt ID or represent a provider-detected continuation. The human owns the decision that the response is suitable. This applies across harnesses and error reasons, not just Claude usage limits.

Normal execution continues to match the first turn after prompt submission. Only explicit Retry may select a replacement. If the latest eligible turn completed, the runtime delivers its completion event. If it is running, the runtime waits for that selected turn without sending another prompt. If it failed, the runtime delivers that failure rather than falling back to an intervening success. Without a replacement, the saved event remains available to the ordinary retry path. A step that failed reading an already-completed response can retry that completed turn as well.

The completion event and response read must target the same selected turn. The runtime persists the durable agent session, harness session, opening sequence and time, and completion time. During the resumed step, conversation reads for that agent are restricted to the selected turn's response and memoized; other agent reads are unchanged. Native adapters enforce that boundary when reading their artifacts. Missing selected content fails visibly; it never falls back to an older or newer response. A new turn after selection does not silently retarget the pending wait or the response read.

## Motivation

A harness may fail, then finish the task after automatic recovery or a human pressing Continue. Replaying only the saved failure makes Retry fail repeatedly even though a usable response now exists. Requiring provider-specific proof that two prompts represent the same request prevents legitimate human-directed recovery. Conversely, combining an old completion with the latest unbounded conversation can advance a workflow using the wrong response.

## Consequences

- Workflow runtime owns replacement selection; adapters own exact response extraction. Explicit Retry refreshes the targeted session's observation before selection, rather than trusting the previous background poll; a refresh error leaves the failed run unchanged. Workflow authors do not implement harness-specific recovery or store harness identities.
- Runtime-only provenance is stored on an ordinary durable `agent_turn` wait. Its condition records the source wait, exact native turn, and failed graph position to resume. The delivered event and selected turn are copied into the next segment attempt's immutable input, but the author's SDK event remains unchanged. No SDK signature, verifier receipt, or database schema changes are required.
- A failed routing segment resumes at the same edge and sees the selected turn's event. A failed node callback resumes at the same execution; conversation reads for the matching agent session use the selected turn. Saved producer operands still take precedence, so Retry never substitutes new turn data underneath a result or routing decision that was already captured before reduction failed.
- Artifact adoption, recovery-wait creation, failure clearing, and the control revision advance commit atomically after selection is checked against the same failed position and owner. A concurrent control or moved position rejects the prepared Retry without partially adopting it.
- The replacement wait is reconciled immediately after it is armed to close the completion-before-commit race. Pausing or restarting does not discard its identity or turn a later completion into an ordinary invocation.
- Agent-turn provenance is found through the retained wait on the current routing execution, or the immediately preceding execution when a response-reading callback failed. Failures with no such retained provenance use ordinary retry behavior; the runtime does not infer an agent turn from arbitrary workflow state.
- Diagnostics identify the selected agent session and turn. Historical failures remain in the event history; recovery does not rewrite them as successes.
