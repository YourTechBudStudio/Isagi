# Author workflows

Create or modify a verified TypeScript workflow package. Authoring and verification do not launch a run.

## Package and sources

For a new workflow, copy the bundled [minimal-workflow scaffold](minimal-workflow/); read its [definition](minimal-workflow/src/index.ts), [tests](minimal-workflow/tests/workflow.test.ts), [package](minimal-workflow/package.json), and [TypeScript settings](minimal-workflow/tsconfig.json). For an existing workflow, inspect its code and preserve its intended behavior while adapting the package contract as needed.

Use the scaffold's exact compatible pins: `@yourtechbudstudio/isagi-workflow-sdk@{{SDK_VERSION}}` in dependencies, and `@yourtechbudstudio/isagi-workflow-verifier@{{VERIFIER_VERSION}}` plus `esbuild@{{BUILDER_VERSION}}` in devDependencies. Prepare dependencies using the target repository's conventions. Keep the canonical build and verify scripts.

The installed SDK is the authority for signatures. Start at `node_modules/@yourtechbudstudio/isagi-workflow-sdk/dist/index.d.ts` and follow its relative exports to the declarations needed for the task: `graph.d.ts`, `nodes.d.ts`, `state.d.ts`, `operations.d.ts`, and `launch.d.ts`. Import public symbols from the package root.

Default-export `defineWorkflow(...)` from `src/index.ts`. Use relative `.js` imports with NodeNext TypeScript. Build one Node ESM artifact with statically resolvable dependencies: native addons, deferred module loading, code splitting, and emitted side assets are outside the bundle contract. Keep sources free of symlinks. Workflows are trusted Node code; verification is not a sandbox.

## Location and discovery

| Package path                                  | Scope   |
| --------------------------------------------- | ------- |
| `{{DATA_ROOT}}/workflows/<key>/`              | Global  |
| `.isagi/workflows/<key>/` at the project root | Project |

Follow an explicit target path; these are discovery defaults. [Global config](config-global.md) explains additional collection roots. Discovery priority is global, then additional roots in listed order, then project. The highest-priority package owns a matching key, even if broken; there is no fallback. The package directory key identifies the launchable workflow; graph keys identify structure inside it.

## Graph structure and composition

`defineWorkflow({ command, validate, environment, graph })` pairs a launch form with a root graph; `environment` is optional. `command(origin)` declares text, select, multi-select, or confirm inputs; keep it usable without optional pane/session context. `validate(origin, inputs)` checks launch inputs. Those inputs become the root graph's parameters. Each graph's pure synchronous `init(destination, parameters)` creates its private state once; initialization is not a migration hook. Destination determines where work is placed; origin describes where the user launched it.

Read [Workflow environments](workflow-environments.md) to choose or create the destination with `environment`, use caller placement overrides, and handle preparation failures.

Compose substantial workflows hierarchically:

| Perspective | Responsibility                              | Example                                        |
| ----------- | ------------------------------------------- | ---------------------------------------------- |
| Business    | Goal and major phases                       | Deliver a story                                |
| Logical     | A coherent process and its policy           | Implement, review, and revise within a budget  |
| Operational | Concrete work, waits, and result collection | An agent turn followed by reading its response |

These are responsibilities, not exactly three wrappers. Keep a tiny workflow flat; add nesting for meaningful ownership, reuse, or recovery boundaries. Optional `intent` metadata describes the perspective without enforcing behavior. For example, a business graph invokes a review-loop graph, which composes writer and reviewer graphs and returns a decision the business graph understands.

Use `subgraph({ graph, parameters, onResult })` to register a child. `parameters(parentState)` passes inputs; `onResult(parentState, result)` maps its published output through the parent's reducers. Both are pure and synchronous. The result includes `outcomeId`, `outcomeKind`, `reason`, and typed `output`. The parent's edge then receives a `subgraph` event. Keep the parent contract focused on meaningful results rather than the child's handles or private state.

One definition can be reused by several subgraph registrations. Routing loops are supported; recursive graph containment is not. Graph execution is sequential, although one headless wait can join several operations. There is no separate child-workflow launch or workflow-join wait.

Graph keys and node, edge, and outcome IDs match `[A-Za-z][A-Za-z0-9_-]{0,63}`. Keep node and outcome IDs distinct within a graph. Use stable IDs for structure, titles/descriptions for purpose, and optional pure `label` callbacks for names captured at graph or node entry. The exported `checkpoint` node is reserved; this release rejects it during verification.

## Operations, waits, and routing

An `operation(async (ctx, state) => ...)` performs work and returns `complete({ update })` or `suspend({ update, wait })`. `complete` finishes this node visit, not the workflow. A wait is a durable declaration returned with `suspend`, not a Promise to await.

| Wait                                  | Delivered event                                                 |
| ------------------------------------- | --------------------------------------------------------------- |
| `wait.userContinue(label)`            | `user_continue`                                                 |
| `wait.userInput(questions)`           | `user_input` with answers                                       |
| `wait.agentTurn(target)`              | `agent_turn` with ended, failed, or interrupted outcome         |
| `wait.headlessAgent(handleOrHandles)` | `headless_agent` with completed, failed, or interrupted results |

Use explicit human waits when the workflow needs a decision or fresh input. For agent capabilities and code patterns, read [Agent work](workflow-agents.md).

Every node has exactly one `edge({ from, to, choose })`. Its pure synchronous `choose(state, event)` returns a declared destination and optional update. Immediate completion produces `event.kind === 'immediate'`; wait completion sends its typed `NodeEvent` directly to the edge, without calling the operation again. Narrow the event by `kind`. Perform conversation/file reads in an operation, then route on captured facts; an edge cannot perform IO or suspend. If a later operation needs event data, store it through an edge update.

Cover each relevant failure and interruption explicitly: select recovery, an alternative, human input, or a declared failure outcome. An ended turn alone does not establish task success. Use `outcome({ kind: 'success' | 'failure', output })` with a pure synchronous output function for terminal domain results; a child's failure outcome reaches the parent as data. An exception in a callback, reducer, or router is an execution failure, not a routable domain result.

During design, answer: “If this fails, what should happen next, and what work must not be repeated?” Ask the user when the recovery policy materially changes their intended workflow and cannot be inferred. Bound retry/review loops with counters in graph state and an explicit exhausted-budget route. A deliberate new visit is different from the runtime Retry control.

## State and updates

Keep parameters, state, updates, and outputs JSON-serializable: plain objects, arrays, primitives, and ISO date strings. Store durable domain facts and recovery budgets; graph structure already owns execution position. Keep child-only data inside the child.

Register a reducer for every state field. Emit partial updates rather than mutating state: an omitted field stays unchanged, and an own field set to `undefined` is rejected. Reducers are pure and synchronous; a failed reduction does not partially apply an update.

`createGraph<State>` uses each stored field type as its update type. Its second type argument overrides only fields whose update type differs. For example, to append individual notes to a stored list:

```ts
import { reduce } from '@yourtechbudstudio/isagi-workflow-sdk';

type State = { readonly notes: readonly string[]; readonly rounds: number };
type Updates = { readonly notes: string };
// In createGraph<State, Updates>({ ... }):
const stateFields = { notes: reduce.append<string>(), rounds: reduce.add() };
// An update { notes: 'Needs tests', rounds: 1 } appends a note and increments rounds.
```

Start with `reduce.replace`. Use `add`, `append`, or `union` for accumulated facts, `collection` for explicit add/remove/clear commands, `optional` for set/clear of nullable values, and `field` or `reduce.custom` for domain-specific updates. Consult `state.d.ts` for their update types.

## Continuation essentials

Completed progress is saved rather than replayed. Resume uses the saved code version; Retry can adopt a newly verified build at a failed segment. When an unfinished operation runs again, matching recorded external calls reuse their results. Preserve the order and requests of those calls; a changed prompt at an already recorded position is not a new attempt. Direct filesystem/process/network effects need their own retry safety. Unknown delivery blocks dependent work rather than authorizing a resend.

For a failed segment with retained agent-turn provenance, explicit Retry can recover from the latest observed turn in that same Isagi agent session without resending the prompt. Routing receives the selected turn's event; a matching `getConversationHistory` read is restricted to the selected completed response. This does not apply to Resume, automatic re-entry, other sessions, or a segment that already saved its producer result or routing decision. See [Workflow recovery](workflow-recovery.md) for the exact boundary.

Read [Workflow recovery](workflow-recovery.md) when editing code for saved runs, writing retry-specific behavior, or dealing with interrupted/uncertain work.

## Completion and verification

Keep tests hermetic with stubbed capabilities. Exercise the routes and updates that determine behavior: meaningful success, failure/interruption, exhausted budgets, human escalation, and child output mapping as applicable. The scaffold demonstrates direct graph tests without a live runtime or provider.

After authoring, run the package's `typecheck` and `test` scripts, then `build`, then `verify`. Verification checks the existing build, package compatibility, declared structure, and loadability; it does not compile, run tests, or prove that routes terminate or produce correct results. Fix failures and rebuild/reverify after changes; source or artifact changes invalidate verification.

Report the commands that passed and any failed or skipped checks. A package is ready only when these checks succeed; live execution is separate from authoring verification.
