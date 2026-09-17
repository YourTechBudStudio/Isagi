# Workflow recovery

Use this reference when repairing a saved run or changing code it may use. For package checks and graph authoring, see [Workflow authoring](workflows.md).

## Choose the kind of continuation

For failures during environment preparation, read [Workflow environments](workflow-environments.md): Retry replays the recorded placement request and base commit without re-running `environment`, and some failures require a new launch. Pause and Resume are refused during preparation; a run interrupted there is failed on restart, with Retry as its re-entry path. The continuation guidance below applies after preparation has completed.

| Intent                                                | Mechanism                            | Authoring consequence                                                                          |
| ----------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Continue saved work after Pause or restart            | Resume                               | Uses the saved verified code version; does not restart initialization or satisfy a human gate  |
| Repair an execution segment that threw                | Retry                                | Can adopt the latest verified composed code; preserves saved state and continuation            |
| Deliberately try work again after a delivered failure | An edge routes to another node visit | Starts new work under the existing version; store a budget and choose an exhausted-budget path |
| Get new input or recheck current facts                | Human wait or a read operation       | Express the desired observation explicitly rather than repeating earlier side effects          |

After environment preparation, Pause gates future execution; an in-flight callback can finish its durable boundary, and external work can continue. Restart parks unfinished runs past preparation until explicit Resume. Cancel prevents further progression and requests best-effort cleanup; it does not undo external effects.

A failure outcome is a graph result, including when delivered by a child. It is not a thrown segment waiting for the Retry control. A failed route can be repaired without repeating the preceding completed operation. A failed parent result mapping can be repaired without rerunning the completed child.

## Editing code for Retry

Preserve the saved graph registrations, node kinds, and pending routing/mapping locations. Retry checks structure before adopting a build; failed loading or structural checks leave the saved version and execution unchanged. These checks cannot prove that new code understands old state, pending events, reducer updates, parameters, or outputs. Review those meanings before retrying; `init` does not migrate saved state. A missing saved build is a recovery failure, not permission for Resume to load newer code.

For an operation callback that failed after external calls, preserve the recorded calls in the same order with the same requests. `spawnAgentSession`, `sendAgentPrompt`, `runHeadlessAgent`, and `closePane` reuse matching recorded results. Changing a recorded request is rejected. If repaired code no longer needs a recorded result, it may still need to make the original call and discard the returned value to preserve that sequence. Put deliberate follow-up work in a subsequent node visit.

`getConversationHistory` is a fresh read and can return changed data. `log` and `setUiFeedback` can be written again; neither is an external-operation receipt. The SDK's `OperationInvocation` exposes `initial`, `resumed`, and `retry` when distinguishing invocation context is necessary; most recovery should be visible in graph routes rather than hidden in retry-only branches.

## Failure, interruption, and unknown delivery

Handle delivered agent failure/interruption through declared routes. A new attempt may encounter files already changed by the previous attempt; assess those effects before repeating work. Bound repeated review or repair work in durable state and choose an alternative, human decision, or terminal result when the budget is exhausted.

A recorded headless launch whose output-capture owner was lost is interrupted unless its result was already committed. Partial output is diagnostic evidence, not a completed judgment. Interruption does not prove the underlying process stopped or its effects were rolled back; inspect the result's interruption and stop information when choosing follow-up work.

Unknown delivery is different: the runtime cannot establish whether an external action happened. It blocks dependent work, and Retry cannot authorize a blind resend. Such a run can remain blocked or be cancelled; do not turn uncertainty into an authored failure event or an automatic replacement launch.

For direct Node filesystem, network, or process work, choose effects safe to repeat or check durable evidence before repeating them. Runtime-managed agent calls do not make arbitrary author code exactly-once or roll back external changes.

## Inspect the failed boundary

From the attached run's workflow bar, Declared shows the pinned graph and Trace shows actual visits and attempts. Use the failed boundary, recorded inputs/results, and diagnostics to identify what needs repair and what already completed. Give nodes meaningful titles and log identifiers, paths, and failure causes from operations so that recovery does not depend on guessing from a phase label.
