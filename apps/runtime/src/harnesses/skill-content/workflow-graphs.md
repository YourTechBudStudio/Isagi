# Graphs

The SDK declarations (`graph.d.ts`, `nodes.d.ts`, `operations.d.ts`, `state.d.ts`) document each call. This file covers how to put them together.

## Launch

`defineWorkflow({ command, parse, placement, graph })` pairs a launch form with a root graph. Keep `command(origin)` usable when optional origin context (surface, pane, agent session) is absent. `parse` turns launch inputs into the root graph's parameters; throw to refuse a launch with a message for the person. `placement` is optional; see [Environments](workflow-environments.md).

```ts
import type { WorkflowInputs, WorkflowOrigin } from '@yourtechbudstudio/isagi-workflow-sdk';

type Parameters = { readonly plan: string; readonly plannerSessionId: number };

// Requires the agent the workflow was launched from.
export const parse = (origin: WorkflowOrigin, inputs: WorkflowInputs): Parameters => {
  if (origin.agentSessionId == null) throw new Error('Launch this from the planner agent pane.');
  if (typeof inputs.plan !== 'string' || inputs.plan === '') throw new Error('Choose a plan.');
  return { plan: inputs.plan, plannerSessionId: origin.agentSessionId };
};
```

## Compose for the watcher

Compose in levels so each graph reads like a plan and clicking a subgraph reveals the next level of detail. A tiny workflow can stay flat.

| Level | Responsibility | Example |
| --- | --- | --- |
| Business | Goal and major phases | Deliver a story |
| Logical | A coherent process and its policy | Implement and review until approved |
| Operational | Concrete work, waits and result collection | One agent turn, then read its reply |

Name graphs and nodes for the person watching the run: `title` says what happens ("Review changes", not "sendPromptAndCollect") and `label` adds the instance ("Implement phase 2: auth"). Register children with `subgraph`; keep the parent contract to meaningful results, not the child's private state. One graph definition can back several subgraph nodes. Loops are routing; recursive graph containment is not supported, and there is no separate child-workflow launch.

## Nodes and routing

- **One effect per operation.** An operation does its preparation, then one side effect (a spawn, a prompt, a headless launch, a pane close), then returns `complete` or `suspend`. Reads (`getConversationHistory`), `log` and `setUiFeedback` are not effects. A second effect is a second node. Effects repeat when a node runs again ([Run recovery](run-recovery.md)), so this keeps repeats small and visible.
- **One node at a time.** A run executes sequentially and each node has one wait; only `wait.headlessAgent([...])` joins several operations. Two agents never work in parallel within a run.
- **Waits are declarations**, returned with `suspend`, not Promises. When the event arrives, the suspend's update is applied first, so `choose` sees it; the edge's update applies after. Ask the person with `wait.userContinue` (they act, then Continue) or `wait.userInput(questions)` (they answer in a form).
- **Edges decide, operations act.** Each node has exactly one `edge`, whose pure synchronous `choose(state, event)` narrows `event.kind` and returns a declared destination. Do IO in an operation and route on the captured facts; store event data the next node needs through the edge's update.
- **Failure is data until it throws.** `outcome({ kind: 'failure' })` reaches the parent as a routable result. An exception in a callback, reducer or edge fails the execution instead.
- **Checkpoints** are their own node kind; see [Checkpoints](workflow-checkpoints.md).

For each wait, ask "if this fails, what happens next, and what must not be repeated?" Route every failure and interruption somewhere deliberate: recovery, an alternative, the person, or a failure outcome. An ended agent turn does not by itself mean the task succeeded. Bound automatic retries with a counter in state and an exhausted-budget route to the person; loops that a reviewer closes may instead escalate to the person rather than count. Ask the user when the recovery policy changes their intended workflow and cannot be inferred.

## State

Keep parameters, state, updates and outputs JSON-serializable. Store durable domain facts, handles later nodes need and retry budgets; graph structure already owns execution position. Keep child-only data in the child. Every field has a reducer; start with `reduce.replace` and pick another only for accumulated facts. `createGraph`'s second type argument overrides a field's update type:

```ts
import { reduce } from '@yourtechbudstudio/isagi-workflow-sdk';

type State = { readonly notes: readonly string[]; readonly rounds: number };
type Updates = { readonly notes: string };
// In createGraph<State, Updates>({ ... }):
const stateFields = { notes: reduce.append<string>(), rounds: reduce.add() };
// An update { notes: 'Needs tests', rounds: 1 } appends a note and increments rounds.
```

`init` runs once per graph invocation and is never a migration hook: keep the meaning of saved state compatible when you edit a workflow that has runs in flight.
