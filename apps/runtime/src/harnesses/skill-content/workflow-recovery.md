# Workflow recovery

Use this reference when a run needs Pause, Resume or Retry, and when designing a workflow that heals itself. For failed environment preparation, use [Workflow environments](workflow-environments.md#failed-preparation).

## What is saved

Each node visit is one execution. Its node function runs once; what it returns (`complete` or `suspend`, with its update and wait) is saved before anything routes, and is never run again by accident. Everything after that is pure and always runs with the current code: the update's reducers, the edge, an outcome's `output`, and a parent's `onResult`, reducers and edge. A pure step that throws fails the execution, names the stage and the graph and node or outcome whose code threw, and changes no state.

## Controls

| Control | Available when | What it does |
| --- | --- | --- |
| Pause | running or waiting | Nothing new starts. A node function already running finishes and its result is saved. A user's answer is stored, but nothing routes until Resume. |
| Resume | paused | Reloads the latest verified build, re-checks every wait, and continues. |
| Retry | failed | Reloads the latest verified build, then repeats the failed execution as a new execution. |
| Cancel | not finished | Stops the run. Running headless processes are stopped on a best-effort basis; agent panes stay open. It undoes nothing. |
| Dismiss | completed, failed or cancelled | Detaches the run from its surface so another run can use it. |

Resume and Retry refuse, leaving the run unchanged, when the latest build no longer fits where the run is parked: every open graph must still be declared, each subgraph link on the way must still enter the same graph, and the parked node must still exist with the same kind. Nodes the run has finished with may change freely. `init` never runs again to migrate saved state, so keep the meaning of active state, events and outputs compatible. Resume and Retry also need the run's surface; a dismissed run, or one whose surface was deleted, cannot continue.

## Retry

Retry adds an execution that points at the failed one (`retry_of`) and copies what it already had:

- a saved result: the node function does not run again, and the pure steps run with the new code, which is how a fixed edge, reducer or outcome is repaired;
- no saved result (the function threw, or was cut off by a restart): the function runs again, and `ctx.execution.attempt` is `'retry'`;
- an agent-turn wait: re-checked after refreshing the session's observation, with the latest-turn rule, so a turn the person ran by hand after the failure counts.

There is no reuse of earlier side effects. A function that runs again sends its prompts and launches its jobs again, so keep each node to its preparation plus **one** side effect.

## After an app restart

A node function that was running is interrupted and the run fails; press Retry to run it again. A run still preparing fails the same way. Every other active run is paused, including one whose result was saved but not yet routed; Resume continues it. A headless job that was running is delivered on Resume as `interrupted` with `{ reason: 'runtime_restarted', launchedAt }`, and an agent session that died is delivered as `interrupted` with `session_died`.

## Healing inside the graph

There is no "run this step again" control. Put recovery in the graph, with a budget in state.

A bounded self-retry suits cheap, mostly read-only work such as a headless check:

```ts
import { edge, eventGuards } from '@yourtechbudstudio/isagi-workflow-sdk';

type State = { readonly checkAttempts: number };
// `check` runs a headless job and adds 1 to `checkAttempts` in its suspend update.
export const afterCheck = edge<State, State>({
  from: 'check',
  to: ['commit', 'check', 'askUser'],
  choose: (state, event) => {
    const passed =
      eventGuards.isHeadless(event) &&
      event.results.every((result) => result.status === 'completed' && result.output?.includes('pass'));
    if (passed) return { to: 'commit' };
    return state.checkAttempts < 2 ? { to: 'check' } : { to: 'askUser' };
  },
});
```

When the budget runs out, or an agent turn fails, ask the person. After they fix things and press Continue, route back to the operation, or to a node with no side effect that re-arms the wait on the same agent:

```ts
import { operation, suspend, wait, type AgentSessionHandle } from '@yourtechbudstudio/isagi-workflow-sdk';

type State = { readonly implementer: AgentSessionHandle | null };
export const askUser = operation<State, State>(async () =>
  suspend({ wait: wait.userContinue('The implementer stopped. Continue it by hand, then Continue.') }),
);
// No new prompt: the latest turn in the session answers the wait.
export const recheck = operation<State, State>(async (_ctx, state) =>
  suspend({ wait: wait.agentTurn(state.implementer!) }),
);
```

Route `askUser` to `recheck`, and route `recheck` like the original agent node: an ended turn continues, anything else goes back to `askUser`. Pressing Continue without running a new turn finds the same failed turn and asks again.

## Diagnose before repeating effects

A delivered failure or interruption is data for an edge. Account for files already changed before routing back to work, and treat partial headless output as diagnostic material. Use [CLI investigation](cli-investigate-runs.md) to read the failed execution, its operations with their prompts and replies, and the run's events. Meaningful node titles and `log` messages with identifiers, paths and causes make this possible without guessing.
