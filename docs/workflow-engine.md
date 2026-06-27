# Workflow Engine

## What it is

The workflow engine is a durable, in-process subsystem of the runtime that executes
**user-authored reducer callbacks as durable state machines**. A workflow drives long-running,
multi-agent work — spawning agent sessions, injecting prompts, waiting for turns to complete,
routing between agents — and survives runtime restarts mid-run.

It exists to automate Isagi's repeatable agent meta-workflows (e.g. the per-phase
implementation loop between an implementation agent and a planner agent) so they can run
unattended. The governing idea: the _plumbing_ between agents is deterministic and lives in
code; the _judgment_ is stochastic and lives in the agents; the human is the switchman at
junctions. The engine is the deterministic plumbing.

The simplest mental model: **a workflow run is a row in a database table, and the engine is a
small set of loops that move that row through a status lifecycle.** Because the row is the
source of truth, surviving a crash reduces to "the row survives."

## The execution model

A workflow is a `step` reducer over an explicit, serializable `state` object. It is **plain
async TypeScript** — never Effect — and returns one of three results:

- `cont(nextState)` — persist and run again immediately (an internal transition).
- `suspend(nextState, condition)` — persist and wait until `condition` holds (a long external
  wait: an agent turn, the user, another workflow, or a headless operation).
- `done(value?)` — terminate and optionally persist a JSON-serializable result.
- `fail(reason)` — terminate as failed with an internal reason. User-facing failure text should be
  written first through `ctx.setUiFeedback`.

The reducer runs synchronously between suspensions, `await`-ing **fast** `ctx` verbs inline. To
wait on anything slow it **returns a `suspend`** — waiting is _always_ the return value, never
hidden inside a verb. On resume the engine calls `step(ctx, state, event)`, where `event` is the
payload that satisfied the wait; the reducer computes the real next state from it.

This shape is what makes the state machine serializable: every `await_*` phase is a named,
serializable continuation, and anything that must cross a suspension lives in `state`, because
there is no live closure to hold locals across the wait.

Author-facing types and constructors live in `@isagi/workflow-sdk`: `WorkflowDefinition`,
`WorkflowLaunchContext`, `WorkflowCommandManifest`, `WorkflowStep`, `WorkflowResult`,
`WorkflowWaitCondition`, `defineWorkflow`, and `cont`/`suspend`/`done`/`fail`. Runtime-only row,
status, repository, and engine error types stay inside `apps/runtime`.

A workflow definition is a data-root TypeScript artifact:

```ts
export default defineWorkflow({
  command: (launchCtx) => ({ title: 'Example', inputs: [] }),
  validate: (launchCtx, variables) => {},
  init: (launchCtx, variables) => ({ phase: 'start' }),
  step: async (ctx, state, event) => cont(state),
});
```

`command`, `validate`, and `init` receive the full launch capture. `step` receives the persisted
state plus a narrow action `ctx`.

## The status lifecycle

```
paused → ready → running → (waiting | ready | done | failed)
waiting → ready → …                       (resolver wakes a waiting run)
(any non-terminal) → paused               (recoverer, at boot)
```

- **waiting** — parked on a condition; carries `wait_kind` + `wait_condition`, no `resume_payload`.
- **ready** — eligible to run now; `wait_kind` is null. Carries `resume_payload` if it was woken
  by an event (vs reaching `ready` via `cont`).
- **running** — a worker is executing one step; `owner` is stamped.
- **done** / **failed** — terminal. `failed` carries an `error`.
- **paused** — parked awaiting an explicit user _continue_ (see Durability).

A load-bearing invariant: **`wait_kind != null` ⟺ the run is `waiting`.** Waking a run clears its
wait fields, so a run's persisted shape unambiguously encodes its lifecycle position. This is what
lets the continue path branch on `wait_kind` alone.

## The three loops

The engine is three single-purpose pieces (see `workflow-engine.service.ts`):

- **Resolver** — the only harness-aware piece. Subscribes to the runtime event bus; when a
  `waiting` run's condition holds, it writes `resume_payload`, flips the run to `ready`, and pokes
  the dispatcher. `turn` waits resolve from harness turn edges; human waits resolve from explicit
  operator operations that directly satisfy the pending gate. The resolver also runs the recovery
  reconcile path on user _continue_ (below).
- **Dispatcher** — the harness-agnostic workhorse. Atomically claims a `ready` row
  (`ready → running`, stamped with `owner`, so two workers can never run one run), executes
  exactly one step, and persists the result. It runs a one-time startup drain, then
  **coalescing-wake + drain-to-empty**, with **no steady-state poll**: a `cont` re-readies its row
  and is caught in the same drain pass, so pokes are reserved for readiness created _outside_ a
  drain (the trigger, the resolver).
- **Recoverer** — a boot-time step that parks every non-terminal run (`waiting`/`ready`/`running`)
  as `paused` and clears `owner`. It runs _before_ the dispatcher's startup drain, so boot never
  processes a row that should be parked.

## Durability model

The engine is **durable-by-design via snapshot-at-suspension — deliberately not Temporal-style
replay.** State is an explicit serialized object on the row; the engine never replays completed
phases. On wake it loads the row and runs one step.

The decisive reason is **edit-resilience**: workflows are hand-edited while runs are in flight, so
re-executing completed phases on recovery would corrupt them. We never re-run a completed phase,
so editing one cannot break recovery. Determinism is required only within the current segment, not
across the multi-hour life of a run.

Restart behaviour:

- **Long waits (99% of wall-clock)** are just a persisted row. Surviving a restart = the row
  surviving.
- The **event bus does not replay across a restart** (the harness-observation layer rebuilds its
  baseline silently on the first reconcile in a fresh process). So a resumed run cannot wait for a
  replayed event — it must **read the JSONL ledger and re-evaluate its condition**.
- Agents do **not** auto-restart on this desktop app. So recovery is **user-gated**: the recoverer
  parks runs as `paused`; the user reopens the surface (restarting its agent sessions) and issues
  _continue_, which reconciles the run against the ledger.
- Recovery _continue_ is distinct from satisfying a workflow's human gate. If a restart parks a run
  that was waiting on `user_continue` or `user_input`, recovery re-arms the row back to `waiting`
  with the same condition. It never auto-satisfies the gate.
- **Fast intra-step effects have no durability in v1.** A crash mid-step replays the step on
  continue, accepting a rare double `inject`/`spawn`. Idempotency keys (keyed by run/phase/seq) are
  the deferred lever.

## Loading and invocation

Workflows live under the runtime data root at `<dataRoot>/workflows/<workflowKey>/index.ts`.
The runtime scaffolds `<dataRoot>/workflows` on boot with `package.json`, `tsconfig.json`, and a
copied built `@isagi/workflow-sdk` package under
`node_modules/@isagi/workflow-sdk`. The copy is version-synced from the app's SDK build and is not a
package-manager install or symlink.

Discovery is on-demand: the registry scans workflow directories when listing or starting workflows.
The registry does not persist workflow definitions in the database. `index.ts` is imported with
`tsx`'s `tsImport`, and the dispatcher re-imports the file for every step. This gives hand-edited
workflows hot reload on the next reducer step.

Starting a workflow is an explicit-context operation. The caller supplies `worktreeId`,
`surfaceId`, and optionally `paneId`; the runtime resolves `worktreePath` and the originating
`agentSessionId` for `launchCtx`. There is no fallback to persisted active context. A workflow run
persists only the launch facts the runtime orchestrates on (`worktree_id`, `surface_id`); other
launch facts are workflow-owned and should be folded into opaque state by `init` if the workflow
needs them after launch.

Start flow:

1. Resolve `launchCtx` from explicit ids.
2. Load the workflow definition.
3. Run `validate(launchCtx, variables)`. A thrown error rejects the start and creates no row.
4. Run `init(launchCtx, variables)` and create a `ready` row with `state_json`.
5. Poke the dispatcher.

## The `ctx` SDK

Workflow callbacks are trusted, in-process, and unsandboxed user code. They run with normal Node
power and the full `ctx` surface; backend interaction should go through `ctx` verbs, while plain
Node file and process work remains available to workflow authors. This is a deliberate trust model,
not a containment boundary.

Callbacks are plain async TypeScript; the engine runs the whole step inside `Effect.tryPromise`, so
each `ctx` verb is a **Promise-returning** crossing of the Effect→Promise boundary
(`apps/runtime/src/workflows/context.ts`). A rejected verb Promise becomes a thrown step, which the
engine records as a `failed` run.

The v1 action surface is `worktreePath` plus seven verbs:

- **`spawnSession({ harness, prompt })` →
  `{ agentSessionId, harnessSessionId, seededAt, paneId }`.** This verb is allowed to take a
  couple of seconds. It adds an agent pane to the run's captured surface, waits for the PTY to come
  live and produce initial startup output, gives the TUI a short settle window, stamps `seededAt`,
  injects the **seed prompt**, then polls the harness metadata for the `harnessSessionId` (which only
  appears after the first inject) and returns it. Every wait is bounded (~10s) and times out into a
  `failed` run rather than hanging the dispatcher.
  - Placement is deterministic and runtime-owned: a single-pane surface splits `right`; otherwise
    the runtime descends through the last child of the layout tree and splits that leaf `down`, so
    repeated agent panes stack in the right/bottom region. A pre-existing vertical-only surface
    therefore appends at the bottom rather than carving a new right column.
  - A missing run `surface_id` is a hard verb failure. Workflows never create surfaces; launch must
    bind the surface explicitly.
- **`inject(agentSessionId, text)`** — a runtime-internal, backend-direct PTY write
  (`PtyService.writeInput`), independent of any frontend attachment. It targets the _durable_
  `agentSessionId` and resolves the _current_ PTY incarnation via
  `AgentSessionService.activePtyProcessId` (no implicit relaunch). Before writing, it reads
  `HarnessLedgerObserver.getTurnEdges(agentSessionId)` and rejects if any `turn_started` remains
  unmatched by a terminal edge. Injection therefore only happens at quiescence and uses bracketed
  paste + Enter (`\x1b[200~…\x1b[201~`, then `\r`).
- **`closePane(paneId)`** — closes a pane on the run's captured surface through
  `SurfaceService.deleteSurfacePane`. The surface service owns the delete plan and session-change
  publication. If the pane is the last pane, the surface is deleted; workflow authors should close
  panes they spawned, not the originating pane.
- **`getConversationHistory(agentSessionId)`** — role-tagged message text from the harness ledger.
- **`runHeadlessPrompt({ prompt, harness, model?, effort?, timeoutMs? })` →
  `{ opId, launch }`.** This launches a trusted, agentic, non-interactive harness run in the
  worktree cwd and returns immediately. `launch.timeoutMs` is normalized before return
  (`timeoutMs ?? 600_000`) so workflows persist a self-contained wait condition:
  `{ kind: 'headless', ops: [{ opId, launch }] }`. The op result is a normalized output transcript,
  not an interactive conversation history:
  `{ opId, status: 'completed' | 'failed', output?, error?, exitCode? }`.
  - Headless prompts are not sandboxed or forced read-only by Isagi. Read-only/idempotent use is an
    author contract. If a workflow author uses a mutating headless prompt, restart reissue may
    duplicate the side effect; idempotency keys or a persisted op table are deferred levers.
  - A non-zero exit becomes a failed per-op result with preserved `output`. Timeout kills the PTY
    and resolves the op as `{ status: 'failed', error: 'timeout', exitCode: null, output? }`.
    Failures are delivered to the reducer; they do not automatically fail the workflow run.
  - The stable `opId` is the workflow handle. On restart, the persisted `opId` is rebound to a new
    PTY incarnation rather than regenerated.
- **`startWorkflow(workflowKey, variables?, context?)` → `runId`.** This starts another workflow
  as a detached, ordinary top-level run in the same worktree. There is no backend parent/child
  hierarchy: the only link is a parent choosing to suspend on the returned `runId`.
  - The child `worktreeId` is derived from the parent run. The parent may omit `surfaceId` to use
    its captured surface, or override to another existing surface in the same worktree.
  - The parent may pass an explicit `agentSessionId`; the runtime validates that the session belongs
    to the selected surface and derives `paneId` for launch context when possible. The session id is
    launch-context input only, not a `workflow_runs` column. Child workflows that need it after
    launch should persist it through their own opaque `init` state.
  - `validate` and `init` run before the child row is created. A validation, init, load, or create
    failure rejects the verb promise, so the parent fails at the call site unless it catches the
    error. A child that starts successfully and later fails is delivered through a workflow JOIN
    result instead.
- **`setUiFeedback({ kind?, phase?, message? })`** — writes the run's display feedback (the engine
  stores it; the client renders it). `kind` is `info | warning | error`; omitted kind defaults to
  `info` before persistence, so stored feedback is always explicit.

**Cancellation tradeoff (v1):** verbs run via `Effect.runPromise`, a detached root fiber, so a
long `spawnSession` poll or pending `inject` is _not_ interrupted when the engine scope closes on
shutdown. Acceptable here — the runtime owns these PTY/session resources regardless, and the gate
runs at concurrency 1. Revisit if verbs ever need to abort cleanly on shutdown.

## Turn detection and the watermark

A workflow waits on an agent **turn** completing. The harness-observation layer emits
`turn_started` / `turn_ended` / `turn_failed` edges (`runtime-events/internal-event-bus.ts`);
each carries `agentSessionId`, `harnessSessionId`, `seq`, and `recordedAt`.

- **Watermark (end-time):** a `turn` wait stores `afterT` (= the inject time, `seededAt`), and is
  satisfied by a terminal edge for the pinned `(agentSessionId, harnessSessionId)` with
  `recordedAt ≥ afterT`. One `isSatisfied(condition, edge)` evaluator serves both the live bus path
  and the reconcile-on-continue path.
- **The harness-session pin:** a run pins the `harnessSessionId` it is driving (Pi resumes the same
  id via `--session`, so it is stable across a runtime restart). On continue, the pin is asserted
  against the latest observed metadata; a genuine mismatch (resume failed / a different agent) marks
  the run `failed`.
- **Orphaned turns** — a turn that can never naturally end — are surfaced as synthesized
  `turn_failed` edges so a waiting run wakes instead of hanging:
  - **`new_start_supersedes`** — a new `turn_started` arrives while a previous turn is still in
    flight (the old turn was interrupted). Computed as a generic pass in `deriveHarnessTurnEdges`,
    harness-agnostically.
  - **`session_died`** — an in-flight turn whose PTY incarnation is gone (status not `running`, or
    no longer the session's `activePtyProcessId`). The live path detects this from observed PTY
    deaths; the boot/reconcile path detects it from the database.
  - Both synthesized failures use the orphaned turn's own `turn_started.recordedAt` and a null
    `seq`, so live and read paths produce equivalent edges. A turn that is both superseded and
    dead-PTY is failed once (supersede first; dead-PTY only on turns still in flight after it).

The reconcile path reads edges through `HarnessLedgerObserver.getTurnEdges(agentSessionId)` — a
pure read (no bus emission) that returns the full derived stream including synthesized failures —
so the engine never derives harness edges itself.

## Headless waits

Headless waits are JOINs over one or more `opId`s. The wait condition stores the stable logical
`opId` plus the normalized launch parameters for each op. The in-memory headless tracker owns the
live PTY process id, output capture, timeout, and result for the current runtime process.

Completion is driven by PTY lifecycle events and timeout timers. When an op reaches a terminal
result, the tracker publishes a `headless_op_completed` internal event. The workflow resolver then
reads the persisted wait condition and wakes the run only when every joined `opId` has a terminal
result. The resume payload is `{ kind: 'headless', results }`, preserving partial success and
failure for the reducer to handle.

Because a headless PTY has no durable agent, terminal, or command owner, the tracker pins its PTY
process id in `PtyService` for the op lifetime. The PTY garbage collector skips pinned orphan PTYs.
Pins are in-memory only: after a restart, abandoned pre-crash headless PTYs can be reaped and the
paused workflow reissues from the persisted `launch` data on operator continue.

Tracker entries are reaped, not accumulated. Once the reducer consumes an op's result — the wake
transaction that readies the run — the engine and resolver call `releaseOps` to drop the entry. The
result is already carried in the persisted resume payload, so the in-memory map stays bounded by
live concurrency rather than growing with a run's cumulative op count. When a run reaches a terminal
state, the tracker observes `workflow_run_terminal` and cancels every op still tracked for that run:
an in-flight PTY is terminated and unpinned so a headless prompt cannot keep running — and, since
prompts are not forced read-only, keep mutating the worktree — after its owning run is already dead.
One residual edge remains by design: an op a reducer launches but neither suspends on nor terminates
the run after (e.g. a reducer that returns `cont`) is reclaimed only by its own timeout.

The engine also reconciles immediately after arming a headless wait. This closes the fast-op race
where a headless process finishes after the verb returns but before the reducer's `suspend` result
has been persisted as a waiting row.

The `inject` guard relies on that same read path. Because superseded and dead-PTY turns are
synthesized into terminal `turn_failed` edges, an unmatched `turn_started` in the returned stream is
treated as a genuinely live turn. This makes the existing end-time watermark sufficient for
workflow loops: a workflow injects only after the previous turn has settled, so the next terminal
edge after `seededAt` is unambiguously the workflow's turn.

## Workflow waits

Workflow waits are JOINs over one or more workflow run ids:
`{ kind: 'workflow', runIds }`. They resolve only after every referenced child run is terminal
(`done` or `failed`). The resume payload preserves the wait condition's input order, independent of
completion order:

```ts
{
  kind: 'workflow',
  results: [
    { runId, status: 'done', result },
    { runId, status: 'failed', error },
  ],
}
```

`result` is the parsed child `result_json` from `done(value)` and remains `unknown` to the parent
workflow. `error` is the parsed child failure payload. Missing referenced run ids fail the waiting
parent loudly; otherwise the parent could wait forever on a row that can never become terminal.

The child terminal state is already durable in `workflow_runs`, so workflow waits are DB-truth
reconciliations. The engine re-checks the child rows at three points:

- immediately after arming a workflow wait, closing the race where a child finishes before the
  parent wait row exists;
- on live `workflow_run_terminal` events, where the event carries the child `runId` and `status`
  only as a latency poke;
- during recovery continue for paused workflow waits.

The guarded `waiting → ready` wake transaction is the idempotency boundary. If arm-time reconcile
and a live terminal event both notice the same satisfied JOIN, one wake wins and the other is a
benign no-op.

## Human waits

Human waits are long waits resolved by explicit operator actions rather than harness events.

- **`user_continue`** stores `{ kind: 'user_continue' }`. The public
  `advance(runId)` operation wakes a waiting run with resume payload `{ kind: 'user_continue' }`.
- **`user_input`** stores `{ kind: 'user_input', questions }`, where `questions` is the static SDK
  question schema (`text`, `select`, `multi-select`, `confirm`). The public
  `advance(runId, answers)` operation validates submitted answers against the persisted questions,
  applies defaults for optional questions, and wakes the run with `{ kind: 'user_input', answers }`.

Validation is strict and runtime-owned: unknown keys, missing required keys, wrong primitive types,
and option values outside the persisted question options are rejected. A rejected submission leaves
the run waiting. A duplicate operator action that arrives after the run has already moved on is
reported as already resolved rather than as a runtime failure.

## Persistence

All run state lives in the `workflow_runs` table (`apps/runtime/src/persistence/schema.ts`). The
runtime owns the row; five columns carry structured data with distinct ownership rules:

- **`state_json`** — opaque workflow state. The runtime **never** introspects it.
- **`wait_condition`** (JSON) — the pending condition; the engine _does_ introspect it (the
  resolver queries it). Only `wait_kind` is an indexed column; the rest lives in the JSON, since
  `status='waiting' AND wait_kind='turn'` already narrows the set and the condition is a per-kind
  tagged union.
- **`resume_payload`** (JSON) — "what woke you"; the resolver writes it, the step reads it (as the
  `event` arg), and the result write clears it.
- **`ui_feedback`** (JSON) — display values; the engine passes them through, the client renders
  them.
- **`result_json`** (JSON) — terminal value written by `done(value)`. It is separate from
  `state_json`: `state_json` is the reducer's current state, while `result_json` is the value other
  workflows can later join on.

The `workflow_run_events` table is an append-only reducer history for debugging hand-edited
workflows. It records the initial state plus each reducer outcome (`cont`, `suspend`, `done`,
`fail`) with the state snapshot and a small JSON trigger. Pure lifecycle transitions such as
`wake`, `pause`, `ready`, and `rearm` are not logged because no reducer ran and no workflow state
changed. Events reference `workflow_runs` with `ON DELETE CASCADE` and are ordered by their
autoincrement `id`.

Result writes are **targeted** to engine-owned columns so a step's immediate `setUiFeedback` write
is never clobbered by a stale snapshot. `owner` is cleared on every result transition. Indexes
cover `status`, `(status, wait_kind)`, `paused`, `worktree_id`, and `surface_id`. `wait_kind`
values are `turn`, `user_continue`, `user_input`, `workflow`, and `headless`; all five are
behaviorally wired in the current spine. `paused` and `cancel_requested` are orthogonal flags, not
lifecycle statuses. Expected failures surface as the tagged
`WorkflowEngineError`
(`unknown_workflow_key`, `workflow_load_failed`, `worktree_not_found`, `surface_not_found`,
`surface_worktree_mismatch`, `workflow_surface_busy`, `workflow_run_not_found`,
`workflow_run_not_failed`, `workflow_wait_not_satisfiable`, `workflow_user_input_invalid`, and
related context-validation reasons).

## Ownership and the client boundary

A run is scoped to a surface (`surface_id`). The runtime owns run status and the `setPaused`,
`clear`, `retry`, and `advance` operations; the client renders status and provides the controls and
input lockdown. Pause and cancel are flags checked at phase boundaries, so an in-flight step
finishes before a clear request reaps the run tree.

## Key decisions and rationale

- **Durable state machine, snapshot-at-suspension, not Temporal replay** — for edit-resilience and
  a natural non-linear phase flow. (The decisive tradeoff of the whole subsystem.)
- **DB is the source of truth** — the row _is_ the run; any in-memory queue/poke is only a latency
  optimization, so restart-survival falls out by construction.
- **State is opaque to the runtime** — decouples the runtime from workflow-internal schema and
  strengthens edit-resilience.
- **`ctx`-as-activity** — verbs are the activities; there is no formal `Activity` type yet (kept
  light; extensible later for non-runtime systems).
- **Verbs are fast; suspension is the return** — no hidden blocking verbs, so every wait is an
  explicit, serializable continuation.
- **No fast-effect durability in v1** — accept a rare double effect on mid-step replay rather than
  journal every activity; idempotency keys are the future lever.
- **User-gated resume** — agents don't auto-restart on a desktop app, so the recoverer parks runs
  and the user reopens + continues; the continue path reuses the same `pause`/`continue` machinery.
- **No steady-state poll** — coalescing wake + drain-to-empty + a one-time boot drain.

## v1 scope and deferrals

This subsystem currently implements the **engine spine** plus the SDK/loading foundation: the seven
verbs above, data-root workflow loading with per-step hot reload, command manifests, validation,
`init`, explicit-context dev start/list triggers, public workflow controls (`setPaused`, `clear`,
`retry`, `advance`), the `turn`, `user_continue`, `user_input`, `workflow`, and `headless` wait
kinds, `done(value)`/`fail(reason)`, `result_json`, and the reducer event log.
Explicitly out of scope here (and tracked in the `agent-workflows` milestone):

- frontend palette/rail rendering;
- Reload Configuration / config-source changes for `.isagi/config.yaml`;
- the frontend surface (rail, lockdown, controls, dynamic panes);
- the agent-facing "run a workflow" tool.

Deliberately deferred design points: idempotency keys for fast effects; precise
command-arg-to-variable type inference; production hardening for TypeScript loading in a packaged
app; richer workflow-controlled pane placement; and an explicit `kill -9` crash test (the engine is
built durable-by-design and was verified via the `workflow_runs` row/logs, the automated suite, and
a manual real-agent run rather than an automated crash harness).

## Where the code lives

- `packages/workflow-sdk` — author-facing workflow types, wait-condition shapes, static question
  types, launch context and command manifest types, conversation types, `defineWorkflow`, and
  result constructors.
- `apps/runtime/src/workflows/` — the engine: `types.ts` (runtime-only row/status/error shapes),
  `context.ts` (the verbs), `scaffold.ts`, `loader.ts`, `registry.ts`, `repository.ts`,
  `resolver.ts`, `workflow-engine.service.ts` (the loops + dev triggers), `api.ts` (the dev route).
- `apps/runtime/src/persistence/schema.ts` — the `workflow_runs` and `workflow_run_events` tables.
- `apps/runtime/src/agent-sessions/harness/` — turn-edge derivation (`turns.ts`), the observer and
  `getTurnEdges` (`observer.service.ts`), conversation reads (`conversation.ts`).
- `apps/runtime/src/runtime-events/internal-event-bus.ts` — the turn-edge events.

Related ADRs: 0005/0006 (durable agent session over disposable PTY incarnations), 0001/0008 (state
ownership and read composition), 0007 (per-invocation harness instrumentation). Shaping history for
this subsystem lives in the `agent-workflows` milestone's planning notes.
