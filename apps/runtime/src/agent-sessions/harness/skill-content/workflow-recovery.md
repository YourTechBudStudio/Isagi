# Workflow recovery

Use this reference when repairing a saved run. For failed environment preparation, use [Workflow environments](workflow-environments.md#failed-preparation).

## Choose the continuation

| Intent | Mechanism | Consequence |
| --- | --- | --- |
| Continue after Pause or restart | Resume | Uses saved code and state; human gates still need answers. |
| Repair a segment that threw | Retry | Can adopt the latest compatible verified build at the saved position. |
| Deliberately repeat work after a delivered failure | Route to a new node visit | Starts new work under the same code version; bound it with a durable budget. |
| Observe new facts or get input | Read operation or human wait | Makes the new observation explicit. |

Pause gates future execution; an in-flight callback and external work can continue. Restart parks unfinished execution until Resume. Cancel stops progression and requests cleanup; it does not undo external effects. A declared failure outcome is a graph result, not a thrown segment waiting for Retry.

A failed edge can be repaired without repeating its completed operation. A failed parent output mapping can be repaired without rerunning its completed child.

## Edit for Retry

Preserve saved graph registrations, node kinds, and pending routing/mapping locations. Retry checks structure before adopting code; rejection leaves the saved version unchanged. Authors must also preserve the meaning of active state, parameters, events, reducer updates, and outputs. `init` does not migrate saved state. Rebuild and verify using [Workflow authoring](workflows.md#completion-and-verification).

When an unfinished callback re-enters, preserve recorded calls in order with the same requests. `spawnAgentSession`, `sendAgentPrompt`, `runHeadlessAgent`, `closePane`, and `captureEvidence` reuse matching results; changing a recorded request fails. Keep a now-unused call if needed to preserve the sequence. Put deliberate new work in a later visit. Direct filesystem, process, and network effects need their own repeatability checks.

`getConversationHistory` normally reads fresh data. To keep judgment input stable, save the selected response before capturing or judging it; see [Workflow evidence](workflow-evidence.md). `log` and `setUiFeedback` may repeat. Use `ctx.invocation` (`initial`, `resumed`, `retry`) only when invocation-specific behavior is needed; ordinary recovery belongs in visible routes.

## Retry after an agent continued

For a failed routing or response-reading segment with retained turn provenance, explicit Retry can select the latest observed turn in the same Isagi session without resending the prompt. It waits if that turn is open, delivers its failure if failed, and restricts matching conversation reads to its completed response. Missing response content fails visibly. Other session reads remain fresh.

This authority belongs to explicit Retry. Resume and ordinary re-entry keep their original association. A saved callback result or routing decision is preserved when retrying a failed reduction. Workflow authors use Isagi handles and ordinary conversation APIs; the runtime selects the native turn.

## Diagnose before repeating effects

Handle confirmed failure/interruption through declared routes, accounting for files already changed. Partial headless output is diagnostic material, not a completed judgment; inspect interruption and stop information before replacing work. Bound retries and choose an exhausted-budget outcome or human gate.

Unknown delivery means the runtime cannot establish whether an action happened. It blocks dependent work; Retry does not authorize resending it. Inspect the evidence, leave the run blocked, or cancel it rather than inventing a failure event.

Use [CLI investigation](cli-investigate-runs.md) to inspect the failed visit, attempts, recorded inputs/results, and code versions. Meaningful node titles and operation logs containing identifiers, paths, and causes make this possible without guessing.
