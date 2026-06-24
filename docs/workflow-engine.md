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

Author-facing types and constructors live in `@isagi/workflow-sdk`: `WorkflowStep`,
`WorkflowResult`, `WorkflowWaitCondition`, `defineWorkflow`, and `cont`/`suspend`/`done`/`fail`.
Runtime-only row, status, repository, and engine error types stay inside `apps/runtime`.

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
  the dispatcher. It also runs the reconcile path on user _continue_ (below).
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
- **Fast intra-step effects have no durability in v1.** A crash mid-step replays the step on
  continue, accepting a rare double `inject`/`spawn`. Idempotency keys (keyed by run/phase/seq) are
  the deferred lever.

## The `ctx` SDK

Workflow callbacks are trusted, in-process, and unsandboxed user code. They run with normal Node
power and the full `ctx` surface; backend interaction should go through `ctx` verbs, while plain
Node file and process work remains available to workflow authors. This is a deliberate trust model,
not a containment boundary.

Callbacks are plain async TypeScript; the engine runs the whole step inside `Effect.tryPromise`, so
each `ctx` verb is a **Promise-returning** crossing of the Effect→Promise boundary
(`apps/runtime/src/workflows/context.ts`). A rejected verb Promise becomes a thrown step, which the
engine records as a `failed` run.

The v1 surface is four verbs:

- **`spawnSession({ harness, prompt })` → `{ agentSessionId, harnessSessionId, seededAt }`.** This
  verb is allowed to take a couple of seconds. It creates the run's surface + agent pane, waits for
  the PTY to come live and its startup output to quiesce, stamps `seededAt`, injects the **seed
  prompt**, then polls the harness metadata for the `harnessSessionId` (which only appears after the
  first inject) and returns it. Every wait is bounded (~10s) and times out into a `failed` run
  rather than hanging the dispatcher.
- **`inject(agentSessionId, text)`** — a runtime-internal, backend-direct PTY write
  (`PtyService.writeInput`), independent of any frontend attachment. It targets the _durable_
  `agentSessionId` and resolves the _current_ PTY incarnation via
  `AgentSessionService.activePtyProcessId` (no implicit relaunch). Injection uses bracketed paste +
  Enter (`\x1b[200~…\x1b[201~`, then `\r`).
- **`getConversationHistory(agentSessionId)`** — role-tagged message text from the harness ledger.
- **`setUiFeedback({ phase?, message? })`** — writes the run's display feedback (the engine stores
  it; the client renders it).

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
cover `status`, `(status, wait_kind)`, `worktree_id`, and `surface_id`. `wait_kind` values are
`turn`, `user_continue`, `user_input`, `workflow`, and `headless`; only `turn` is behaviorally wired
in the current spine. Expected failures surface as the tagged `WorkflowEngineError`
(`unknown_workflow_key`, `no_active_worktree`,
`workflow_run_not_found`, `workflow_run_not_paused`).

## Ownership and the client boundary

A run is scoped to a surface (`surface_id`). The runtime owns run status and the `pause` / `cancel`
/ `continue` _operations_; the client renders status and provides the controls and input lockdown.
The engine exposes the `paused` status and the continue operation; the UI is the frontend's
responsibility.

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

This subsystem currently implements the **engine spine** plus the Phase 1 SDK foundation: the four
verbs above, a hardcoded workflow registry, dev-only start/continue triggers, the `turn` wait kind,
`done(value)`/`fail(reason)`, `result_json`, and the reducer event log. Explicitly out of scope here
(and tracked in the `agent-workflows` milestone):

- the remaining `ctx` verbs (`runHeadlessPrompt`, `startWorkflow`, `closePane`), unwired wait kinds
  (`user_continue`, `user_input`, `workflow`, `headless`), dynamic workflow loading/hot-reload,
  command manifests, validation, launch context, and the real start-a-run API — later phases of the
  SDK + invocation task;
- the frontend surface (rail, lockdown, controls, dynamic panes);
- the agent-facing "run a workflow" tool.

Deliberately deferred design points: start-anchored turn pairing (for multi-turn workflows that can
race a prior in-flight turn); idempotency keys for fast effects; command-manifest and launch-context
typing; and an explicit `kill -9` crash test (the engine is built durable-by-design and was verified
via the `workflow_runs` row/logs, the automated suite, and a manual real-agent run rather than an
automated crash harness).

## Where the code lives

- `packages/workflow-sdk` — author-facing workflow types, wait-condition shapes, static question
  types, conversation types, `defineWorkflow`, and result constructors.
- `apps/runtime/src/workflows/` — the engine: `types.ts` (runtime-only row/status/error shapes),
  `context.ts` (the verbs), `registry.ts`, `repository.ts`, `resolver.ts`,
  `workflow-engine.service.ts` (the loops + dev triggers), `api.ts` (the dev route).
- `apps/runtime/src/persistence/schema.ts` — the `workflow_runs` and `workflow_run_events` tables.
- `apps/runtime/src/agent-sessions/harness/` — turn-edge derivation (`turns.ts`), the observer and
  `getTurnEdges` (`observer.service.ts`), conversation reads (`conversation.ts`).
- `apps/runtime/src/runtime-events/internal-event-bus.ts` — the turn-edge events.

Related ADRs: 0005/0006 (durable agent session over disposable PTY incarnations), 0001/0008 (state
ownership and read composition), 0007 (per-invocation harness instrumentation). Shaping history for
this subsystem lives in the `agent-workflows` milestone's planning notes.
