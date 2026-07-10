# Workflows

A workflow is a durable state machine that drives agents. The
[SDK source](sdk/index.ts) is authoritative for types and signatures; this reference covers the
operational rules the type system cannot express.

A one-off task is not a workflow. Use one when a process repeats, spans hours, must survive an app
restart, or needs the user at a deliberate junction.

## Location and loading

```text
{{DATA_ROOT}}/workflows/<key>/index.ts      global - available in every project
.isagi/workflows/<key>/index.ts             project - committed with the repository
```

The directory name is the workflow key. `index.ts` must default-export `defineWorkflow(...)`.
Related files may sit beside it; import them with relative paths ending in `.js`.

When both roots contain the same key, the project workflow wins. Project workflow directories have
no `node_modules` or `tsconfig.json`; editors may not resolve `@isagi/workflow-sdk`, but Isagi does
when it compiles the workflow.

## Execution model

`step(ctx, state, event)` is a reducer. Isagi calls it, persists the returned state, and either runs
the next step or waits. Only JSON-serializable `state` survives a suspension: use primitives, plain
objects, arrays, and ISO strings rather than `Date`, `Map`, `Set`, or class instances.

Return only through `cont`, `suspend`, `done`, and `fail`. Build wait conditions only with `wait.*`.
Never construct workflow result or wait-condition objects directly. Waiting is a return value, not a
Promise to await:

```ts
const sent = await ctx.sendAgentPrompt(agentSessionId, prompt);
return suspend(nextState, wait.agentTurn(sent));
```

Nothing is exactly-once. A crash during a step can replay `spawnAgentSession`, `sendAgentPrompt`, or
another fast verb. Keep the effect of a replay safe and do not make correctness depend on a verb
running once.

After a restart, unfinished runs are parked as paused until the user resumes them. A `userContinue`
or `userInput` wait re-arms; restart never satisfies it. `pause` and `resume` gate dispatch and are
not workflow statuses.

Isagi loads the current source for every next step. If a live run holds state written by older code,
renaming a stage or changing its data shape can make that run unreadable. Finish live runs before a
state-shape refactor, or keep the old shape readable. `stateVersion` is only your convention; Isagi
does not migrate or validate it.

## Definition and reducer shape

`command` returns the command-palette manifest. It must not depend on `paneId` or `agentSessionId`
because verification calls it with a synthetic launch context. `validate` rejects unusable launch
contexts and variables before a run row exists. `init` copies every launch fact the reducer will
need into its first state.

Use `state.stage` for internal control flow. Use `setUiFeedback({ phase })` for the business-facing
status the user reads. If the workflow itself implements phases, keep that domain fact separately as
`currentPhase` or similar. Do not overload one field with all three meanings.

Make `stage` a discriminated union. Put transient data in the stage that owns it and durable facts
used across many stages at the top level:

```ts
type Stage =
  | { readonly kind: 'spawn_reviewer' }
  | { readonly kind: 'await_review'; readonly reviewer: Reviewer };

type State = {
  readonly stateVersion: 1;
  readonly authorSessionId: number;
  readonly stage: Stage;
};
```

Make `step` one exhaustive switch over `state.stage.kind`, with one case per durable stage. Prefer
`await_plan_discovery` and `await_review` over a generic `await_headless` plus a second discriminator;
the latter is a nested state machine in disguise. Use `satisfies State` on transition payloads, but
remember that it checks types, not stale optional data.

Before writing a `require*` accessor, ask whether the value belongs in a stage variant. If only one
stage needs it, it usually does.

## Waits, events, and sessions

Pass the target returned by `spawnAgentSession` or `sendAgentPrompt` directly to `wait.agentTurn`.
Persist only the stable identifiers needed later, not the raw SDK return object:

```ts
const spawned = await ctx.spawnAgentSession({ harness: 'claude', prompt });
const reviewer = {
  agentSessionId: spawned.agentSessionId,
  paneId: spawned.paneId,
};
return suspend(
  { ...state, stage: { kind: 'await_review', reviewer } } satisfies State,
  wait.agentTurn(spawned),
);
```

`event` is `unknown`. Every resumed stage must narrow the event that satisfied its wait and fail
loudly on an unexpected or failed result. Use the helpers under `event` in the SDK; do not destructure
an event before narrowing it.

Keep provider and harness-session identity out of workflow state. Durable `agentSessionId` and
`paneId` are enough. Do not reset, resume, or switch the underlying harness conversation while a
workflow-controlled turn is active.

Send one prompt per turn; `sendAgentPrompt` rejects while a turn is in flight. Close panes the
workflow spawned when it no longer needs them. Never close the pane the workflow was launched from.

`wait.workflow` and `wait.headlessAgent` join all supplied operations. A failed child run or headless
operation still satisfies the wait; the resumed stage must inspect the results and decide what to do.

## Conversations and judgments

`getConversationHistory` returns role-tagged messages. A harness may emit several assistant messages
during one turn, so collect the latest complete assistant turn rather than assuming the last message
contains the whole response.

A headless judgment should answer one closed routing question. Keep its prompt, exact JSON parser,
and result type together in a separate module when judgments make the reducer hard to scan.

Model outgoing edges, not every nuance in the prose. If questions, pushback, and partial work all go
to the same next stage, collapse them into one outcome. Prefer one tagged result such as
`{"outcome":"approved"}` over a chain of booleans. When outcomes have precedence, state it in the
prompt.

The prompt and parser are one contract: request one exact JSON object, validate its exact key set and
value domain, and reject extra fields. Headless runs are CLI invocations without constrained output.
On failure, log the judgment name and raw output; that text is the evidence needed to debug it.

Tell workflow-driven agents that they are unattended. Give them the goal, inputs, constraints,
success criteria, stop conditions, and what to do when uncertain. A clarifying question sent to an
empty room is not a recovery strategy.

## Feedback and diagnostics

`setUiFeedback` tells the user what the workflow is doing. Its `phase` is a stable business status,
not `state.stage.kind`. Update it when that business status changes; an internal classifier
transition may leave the existing feedback in place.

`ctx.log` carries evidence: ids, paths, operation ids, parsed payloads, and failure causes. A failure
needs specific user feedback before `fail(reason)`, plus diagnostic context in the log. Avoid generic
copy such as `Workflow setup failed` after setup is already complete.

## Verify

After every edit, run this from the worktree root:

```sh
{{VERIFY_COMMAND}}
```

Replace `<workflow-key>` with the directory name. `$ISAGI_RUNTIME_URL` points at the local runtime.
A successful API envelope contains `"data":{"ok":true}`. Failures contain diagnostics with one of
these stages:

| Stage     | Meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `resolve` | No workflow with that key was found.                                  |
| `compile` | TypeScript did not compile.                                            |
| `load`    | The compiled module could not be imported.                             |
| `shape`   | The default export is missing `command`, `validate`, `init`, or `step`. |
| `command` | `command()` threw while building the manifest.                         |

Fix and rerun until `ok` is true. Check `data.scope`: it reports whether the project or global root
answered. Verification proves that the workflow resolves, compiles, imports, and builds its manifest.
It does not call `validate`, `init`, or `step`, and it does not prove the state machine is correct.
