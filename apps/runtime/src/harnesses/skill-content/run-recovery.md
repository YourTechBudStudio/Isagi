# Run recovery

Controls for a run that is paused, failed or interrupted, in the app or with `isagi runs pause|resume|retry|cancel <run>` ([CLI](cli-investigate-runs.md#controls)). For a run that failed while preparing its worktree or surface, see [Environments](workflow-environments.md#failed-preparation). To design recovery into a workflow, see [Graphs](workflow-graphs.md#nodes-and-routing) and the [Agent turn recipe](workflow-recipes.md#agent-turn).

## What is saved

Each node visit is one execution. What its node function returns (`complete` or `suspend`, with the update and wait) is saved before anything routes, and is never re-run by accident. Everything after it is pure and always runs with the current code: reducers, the edge, an outcome's `output`, and a parent's `onResult`, reducers and edge. A pure step that throws fails the execution, names the stage and the graph and node or outcome that threw, and changes no state.

## Controls

| Control | Available when | What it does |
| --- | --- | --- |
| Pause | running or waiting | Nothing new starts. A running node function finishes and its result is saved; a person's answer is stored but nothing routes until Resume. |
| Resume | paused | Reloads the latest verified build, re-checks every wait, and continues. |
| Retry | failed | Reloads the latest verified build and repeats the failed execution as a new one. |
| Cancel | not finished | Stops the run and best-effort stops headless processes. Agent panes stay open; nothing is undone. |
| Dismiss (app only) | completed, failed or cancelled | Detaches the run from its surface so another run can use it. |

Resume and Retry refuse, changing nothing, when the latest build no longer fits where the run is parked: every open graph must still be declared, each subgraph link on the path must enter the same graph, and the parked node must exist with the same kind. Finished nodes may change freely. Both need the run's surface, so a dismissed run or one whose surface was deleted cannot continue.

## Retry

Retry adds an execution pointing at the failed one (`retry_of`):

- **Saved result** (a pure step threw): the node function does not run again; the pure steps rerun with the new code. This is how a fixed edge, reducer or outcome repairs a run.
- **No saved result** (the function threw, or a restart cut it off): the function runs again with `ctx.execution.attempt === 'retry'`, and its side effects repeat.
- **Agent-turn wait**: re-checked with the [latest-turn rule](workflow-agents.md#which-turn-answers-a-wait).

## After an app restart

A node function that was running is interrupted and its run fails: Retry. A run still preparing fails the same way. Every other active run is paused, including one whose result was saved but not routed: Resume. On Resume, a headless job that was running is delivered as `interrupted` with `{ reason: 'runtime_restarted', launchedAt }`, and a dead agent session as `interrupted` with `session_died`.

## Before repeating work

A delivered failure is data for an edge. Before routing back to work, account for files already changed, and treat partial headless output as diagnostics, not a result. [CLI investigation](cli-investigate-runs.md) reads the failed execution, its prompts and replies, and the event log.
