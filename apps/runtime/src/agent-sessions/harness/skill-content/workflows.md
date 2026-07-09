# Workflows

A workflow is a durable state machine that drives agents. Isagi runs the plumbing; the agents supply
the judgment; the user stands at the junctions you choose to put them at.

Read this file for the mechanics. Read [Workflow style](workflow-style.md) before you write one.

## What a workflow is

`step` is a reducer over an explicit, serializable `state` object. Isagi calls it, you return what
should happen next, Isagi persists the new state, and the cycle repeats. It is plain async
TypeScript.

The whole design turns on one rule: **waiting is a return value, never something you await.** A
workflow that needs an agent to finish its turn does not block on it. It returns a `suspend` carrying
the next state and the condition to wait for. Isagi persists that row and forgets about the workflow
until the condition holds, then calls `step` again with the event that satisfied it.

This is why nothing survives a suspension except `state`. There is no live closure holding your local
variables across the wait - the process may have restarted in between. Anything you will need later
goes into `state`, and `state` must round-trip through JSON.

## Where workflows live

```
{{DATA_ROOT}}/workflows/<key>/index.ts      global - available in every project
.isagi/workflows/<key>/index.ts             project - committed with the repository
```

The directory name is the workflow key. `index.ts` must `export default` a `defineWorkflow(...)`
call. Both roots may hold more files; import them with relative paths and a `.js` extension, the way
TypeScript's Node resolution requires.

**When a key exists in both roots, the project copy wins** for runs launched from that project. This
is the usual explanation for "I edited the global workflow and nothing changed."

Project workflow directories get no `node_modules` and no `tsconfig.json` - Isagi never writes into
the user's repository. Editors will not resolve `@isagi/workflow-sdk` there. Use the
[SDK source](sdk/index.ts) as the reference; Isagi resolves the real package when it compiles.

## The four results

| Return                          | Meaning                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `cont(nextState)`               | Persist and run `step` again immediately. An internal transition.                                    |
| `suspend(nextState, condition)` | Persist and wait until the condition holds.                                                          |
| `done(value?)`                  | Finish. The optional value is JSON and can be joined on by a parent workflow.                        |
| `fail(reason)`                  | Finish as failed. The reason is internal; write the user-facing text with `ctx.setUiFeedback` first. |

## A complete workflow

This one spawns a reviewer, waits for it, relays its answer into the pane the user started from, and
cleans up after itself. Read it before writing your own; every rule in
[Workflow style](workflow-style.md) is a refinement of something visible here.

```ts
{{EXAMPLE_WORKFLOW}}
```

## The definition: command, validate, init, step

`command(launchCtx)` returns the manifest: the title the user sees in the command palette, an optional
description, and the inputs to collect before starting.

**`command` must not depend on `paneId` or `agentSessionId`.** Verification calls it with a synthetic
launch context that has neither. Build the title and inputs from the key, the variables schema, and at
most `worktreePath`.

`validate(launchCtx, variables)` throws to reject a start. Nothing is created when it throws. This is
where you reject a null `launchCtx.agentSessionId` if your workflow drives the pane it was launched
from, and where you reject variables you cannot use.

`init(launchCtx, variables)` returns the first `state`. Fold whatever launch facts you need into it -
Isagi persists only `worktreeId` and `surfaceId` on the run itself, and hands `step` nothing but
`ctx`, `state`, and `event`.

`step(ctx, state, event)` is the reducer. `event` is `unknown`: it is whatever satisfied your last
wait, or `undefined` on the first call and after a `cont`.

## Waits

Build conditions with `wait`; never hand-write the literals.

| Condition                   | Satisfied when                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `wait.agentTurn(target)`    | The agent finishes the turn your prompt started. `target` is the return value of `spawnAgentSession` or `sendAgentPrompt`. |
| `wait.userContinue()`       | The user clicks continue.                                                                                                  |
| `wait.userInput(questions)` | The user answers. Isagi validates the answers against the questions and applies defaults.                                  |
| `wait.workflow(runIds)`     | Every child run listed has finished, `done` or `failed`.                                                                   |
| `wait.headlessAgent(ops)`   | Every headless op listed has reached a terminal result.                                                                    |

`wait.workflow` and `wait.headlessAgent` take one item or an array, and join: they resolve only when
_all_ of them are terminal.

A failed child workflow does **not** fail its parent. The parent wakes with the results and decides.
The same is true of a failed headless op.

## Reading the resume event

`event` is `unknown` on purpose - the type system cannot know which wait you armed. Narrow it, and
fail loudly when it is not what you expected. A workflow that assumes will corrupt its own state.

```ts
if (!workflowEvent.isAgentTurnEnded(event)) {
  return fail('Expected the reviewer turn to end.');
}
```

Available: `isUserContinue`, `isUserInput`, `isAgentTurnEnded`, `isAgentTurnFailed`,
`requireAgentTurnEnded`, `requireAgentTurnFailed`, `getAgentTurnResult`, `getWorkflowResults`,
`getHeadlessAgentResults`. The `require*` helpers throw; the `get*` helpers return `null` when the
event is a different shape.

## The ctx verbs

Every verb is fast and returns a Promise. `await` them inline. None of them waits for an agent - that
is what `suspend` is for.

| Verb                                                                 | Notes                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.worktreePath`                                                   | Not a verb; the absolute path the run is working in.                                                                                                                                                       |
| `spawnAgentSession({ harness, prompt, model?, effort? })`            | Adds a pane, waits for the process, sends the seed prompt. Takes a few seconds. Returns an agent-turn wait target plus `paneId`. Fails if the run has no surface; workflows never create surfaces.         |
| `sendAgentPrompt(agentSessionId, text)`                              | Writes into an existing agent. **Rejects if that agent has a turn in flight.** Returns an agent-turn wait target.                                                                                          |
| `closePane(paneId)`                                                  | Closes a pane on the run's surface. Close the panes you spawned. Do not close the pane the workflow was launched from.                                                                                     |
| `getConversationHistory({ agentSessionId, harnessSessionId })`       | Role-tagged messages. Both ids required.                                                                                                                                                                   |
| `getHarnessSessionId(agentSessionId)`                                | The current harness session id for a durable agent session. Use it when starting from an existing pane.                                                                                                    |
| `runHeadlessAgent({ prompt, harness, model?, effort?, timeoutMs? })` | Launches a non-interactive agent and returns immediately with `{ opId, launch }`. The result is an output transcript, not a conversation. Not sandboxed and not read-only - that is your contract to keep. |
| `startWorkflow(key, variables?, context?)`                           | Starts a child run and returns its `runId`. Suspend on it with `wait.workflow`.                                                                                                                            |
| `log(level, message)`                                                | Forensic detail for whoever debugs this run.                                                                                                                                                               |
| `setUiFeedback({ kind?, phase?, message? })`                         | What the user reads while the run is live.                                                                                                                                                                 |

`log` and `setUiFeedback` write to the same user-visible stream but do different jobs. See
[Workflow style](workflow-style.md).

## Pinning a harness session

An agent-turn wait pins three things: the durable `agentSessionId`, the exact `harnessSessionId` the
prompt went to, and `sentAt`. That triple is exactly what `spawnAgentSession` and `sendAgentPrompt`
return, which is why you pass their return value straight into `wait.agentTurn`.

The pin matters because a durable agent session can be restarted and get a new harness session
underneath it. A wait pinned to the old one, or a conversation read pinned to the old one, is reading
a stream that no longer exists.

**Re-pin from every `sendAgentPrompt` return.** If you keep an agent's identity in `state`, overwrite
its `harnessSessionId` and `sentAt` with what the verb just gave you:

```ts
const sent = await ctx.sendAgentPrompt(reviewer.agentSessionId, prompt);
const pinned = { ...reviewer, harnessSessionId: sent.harnessSessionId, sentAt: sent.sentAt };
return suspend(
  { ...state, phase: { kind: 'await_review', reviewer: pinned } },
  wait.agentTurn(sent),
);
```

## Runs, pausing, and restarts

A run is a row. Starting a workflow creates it; the row surviving a crash is what "durable" means.

- One root run per surface at a time. A finished run keeps blocking the surface until the user clears
  it.
- `pause` and `resume` gate dispatch. They are not statuses, and pausing never satisfies a wait.
- After a restart, Isagi parks every unfinished run as paused. The user reopens the surface, which
  restarts the agents, and resumes. A run parked on `userContinue` or `userInput` re-arms its gate; it
  is never auto-satisfied.
- A crash in the middle of a step replays that step on resume. A `sendAgentPrompt` or
  `spawnAgentSession` can therefore happen twice, rarely. Do not build a workflow whose correctness
  depends on a fast verb running exactly once.

## Editing a workflow that has live runs

Isagi never replays completed phases. It loads the current source and calls `step` once with the
persisted state. This is what makes hand-editing a workflow safe while a run is in flight - and it is
also the trap.

**The state on the row was written by the old code. The `step` that reads it is the new code.** Rename
a phase, change a field's shape, or move data between phases, and a suspended run resumes into a
reducer that cannot understand its own state. Nothing warns you.

Two workable habits: keep the state shape stable while runs are in flight, or finish the runs before
you reshape it. `stateVersion` in the example is a convention that makes a mismatch _visible_ if you
check it. Isagi does not read it, does not migrate anything, and will not stop you.

Root precedence is also re-evaluated on every load, so adding a project workflow that shadows a global
key can hand the next step of a live run to different code.

## Verify

After every edit, from the **worktree root**:

```sh
{{VERIFY_COMMAND}}
```

Replace `<workflow-key>` with the directory name. `$ISAGI_RUNTIME_URL` is already set in this
session and points at the local Isagi runtime.

The response is an API envelope. The useful result is in `data`. A success looks like
`{"data":{"ok":true,...,"manifest":{...}},...}`. A failure returns
`{"data":{"ok":false,...,"diagnostics":[...]},...}` with a `stage` on each diagnostic:

| Stage     | What failed                                                                       |
| --------- | --------------------------------------------------------------------------------- |
| `resolve` | No workflow with that key. The diagnostic usually lists the keys that were found. |
| `compile` | TypeScript did not compile.                                                       |
| `load`    | The module threw while being imported.                                            |
| `shape`   | The default export is missing `command`, `validate`, `init`, or `step`.           |
| `command` | Your `command()` threw.                                                           |

Fix and rerun until `ok` is true.

**Check the `scope` in the response.** It echoes which root answered:
`{"kind":"project","projectId":N}` or `{"kind":"global"}`. If you are editing a project workflow and
`scope` comes back `"global"`, you ran the command from somewhere other than the worktree root, and
you just verified a different workflow - or none.

Verification compiles, imports, shape-checks, and calls `command()`. It does not call `validate`,
`init`, or `step`, and it does not start a run. It proves the workflow loads. It cannot prove the
workflow is correct.
