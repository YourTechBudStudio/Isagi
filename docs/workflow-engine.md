# Workflow Subsystem

## What it is

The workflow subsystem is a durable, in-process part of the runtime that executes
**user-authored reducer callbacks as durable state machines**, together with the run-centric
API, event surfaces, and client boundary that expose those runs. A workflow drives long-running,
multi-agent work — spawning agent sessions, sending prompts, waiting for turns to complete,
routing between agents — and survives runtime restarts mid-run.

It exists to automate Isagi's repeatable agent meta-workflows (e.g. the per-phase
implementation loop between an implementation agent and a planner agent) so they can run
unattended. The governing idea: the _plumbing_ between agents is deterministic and lives in
code; the _judgment_ is stochastic and lives in the agents; the human is the switchman at
junctions. The engine is the deterministic plumbing.

The simplest mental model: **a workflow run is a row in a database table, and the engine is a
small set of loops that move that row through a status lifecycle.** Because the row is the
source of truth, surviving a crash reduces to "the row survives." Everything above the engine —
the HTTP/WebSocket API, the runtime-bus summary events, and the web store — is a **read-centric
projection of run rows**. The run, identified by `runId`, is the canonical thing; a surface is
where a run is _shown_, not what owns it.

This document covers the whole subsystem: the execution model, run identity, the lifecycle, the
three engine loops, durability and recovery, the author SDK, the wait kinds, the run API, the
three event surfaces, persistence, and the client boundary.

## The execution model

A workflow is a `step` reducer over an explicit, serializable `state` object. It is **plain
async TypeScript** — never Effect — and returns one of four results:

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

This shape is what makes the state machine serializable: every wait phase is a named,
serializable continuation, and anything that must cross a suspension lives in `state`, because
there is no live closure to hold locals across the wait.

Author-facing types and constructors live in `@yourtechbudstudio/isagi-workflow-sdk`: `WorkflowDefinition`,
`WorkflowLaunchContext`, `WorkflowCommandManifest`, `WorkflowStep`, `WorkflowResult`,
`WorkflowWaitCondition`, `WorkflowContext`, `defineWorkflow`, `cont`/`suspend`/`done`/`fail`, and
the `wait`/`event` helper objects. Runtime-only row, status, repository, and engine error types
stay inside `apps/runtime`.

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

## Run identity and the lifecycle

### Run identity

Every run is a row with three identity columns:

- **`runId`** (`id`) — the run itself.
- **`parentRunId`** — the run that started it, or null.
- **`rootRunId`** — the top of the tree.

A **root run** has `parentRunId = null` and `rootRunId = id`. A **child run** carries its
parent's `rootRunId`. A **run tree** is every row sharing one `rootRunId`. Child runs exist only
because a parent suspended on a `workflow` wait over the child's `runId` (see Waits). There is no
separate parent/child bookkeeping beyond these columns.

`surfaceId` and `worktreeId` are ordinary fields on the row. A surface is a **projection input
and display target**, never the owner of run identity or controls — this is the core shift of the
run-centric model. At most one root run may exist per surface at a time: starting a new root is
rejected with `workflow_surface_busy` while any root run still exists on that surface — including a
terminal `done`/`failed` one — until it is cleared (or dismissed).

### The lifecycle

Persisted lifecycle status is exactly five values:

```
ready → running → (waiting | ready | done | failed)
waiting → ready → …            (resolver wakes a waiting run)
```

- **ready** — eligible to run now; `wait_kind` is null. Carries `resume_payload` if it was woken
  by an event (vs reaching `ready` via `cont`).
- **running** — a worker is executing one step; `owner` is stamped.
- **waiting** — parked on a condition; carries `wait_kind` + `wait_condition`, no `resume_payload`.
- **done** / **failed** — terminal. `failed` carries an `error`.

**`paused` and `cancel_requested` are orthogonal boolean columns, not statuses.** A run has a
status _and_ a paused flag, and the two are independent. This is the most important correction
from earlier models that drew `paused` as a lifecycle node: pausing never changes `status`, it
gates dispatch (see Durability).

A load-bearing invariant: **`wait_kind != null` ⟺ the run is `waiting`.** Waking a run clears its
wait fields, so a run's persisted shape unambiguously encodes its lifecycle position.

The web **derives presentation** — driving / waiting-for-user / paused / failed / done — from
`status`, `paused`, and `blockingWait`, where `blockingWait` is a _projection field_ on the run
summary (see The run API, The client boundary), **not** a persisted lifecycle fact. The engine
persists only `status`, `paused`, and `wait_kind`/`wait_condition`.

## The three loops

The engine is three single-purpose pieces (see `workflow-engine.service.ts`):

- **Resolver** — the only harness-aware piece. Subscribes to the runtime event bus; when a
  `waiting` run's condition holds, it writes `resume_payload`, flips the run to `ready`, and pokes
  the dispatcher. `agent_turn` waits resolve from harness turn edges; `workflow` waits from child
  terminal rows; `headless_agent` waits from the headless tracker; human waits from explicit
  operator `advance`. The resolver also drives the reconcile-on-resume recovery path (below).
- **Dispatcher** — the harness-agnostic workhorse. Atomically claims a `ready` row
  (`ready → running`, stamped with `owner`, so two workers can never run one run), executes
  exactly one step, and persists the result. It runs a one-time startup drain, then
  **coalescing-wake + drain-to-empty** over a sliding wake queue, with **no steady-state poll**: a
  `cont` re-readies its row and is caught in the same drain pass, so pokes are reserved for
  readiness created _outside_ a drain (the trigger, the resolver). A `ready` run whose
  `cancel_requested` is set has its tree deleted instead of executed.
- **Recoverer** — a boot-time step (`repository.pauseNonTerminalRuns`) that sets `paused = true`
  on every non-terminal run (`waiting`/`ready`/`running`) and clears `owner`, normalizing a
  mid-flight `running` row back to `ready`. It runs _before_ the dispatcher's startup drain, so
  boot never processes a row that should be parked.

The run **projection** — which pushes summaries to clients (see Event surfaces, The client
boundary) — is a separate read/projection concern and is deliberately _not_ part of the engine's
execution spine.

## Durability and recovery

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
  `resume`, which unpauses the tree and runs the per-run continue path (`continuePausedRun`),
  re-evaluating each run's persisted wait against durable truth (harness ledger/artifacts and DB
  rows), not bus replay.
- Recovery resume is distinct from satisfying a workflow's human gate. If a restart parks a run
  that was waiting on `user_continue` or `user_input`, resume re-arms the row back to `waiting`
  with the same condition. It never auto-satisfies the gate.

Pause is an orthogonal dispatch gate with precise semantics:

- A paused **`ready`** run is not claimed by the dispatcher.
- A paused **`waiting`** run may still be woken by the resolver/reconcile into `ready` with
  `paused = true`; it simply remains gated from dispatch.
- A paused **`running`** step finishes and persists its normal result; further dispatch is gated.
- `resume` (unpause) dispatches the current durable state; human waits re-arm rather than
  auto-satisfy.

**Fast intra-step effects have no durability in v1.** A crash mid-step replays the step on resume,
accepting a rare double `sendAgentPrompt`/`spawnAgentSession`. Idempotency keys (keyed by
run/phase/seq) are the deferred lever.

## Loading and invocation

Workflows load from an ordered chain of discovery sources, evaluated from lowest to highest priority:

- the **core data-root source** under the runtime data root, `<dataRoot>/workflows/<workflowKey>/`;
- any **configured additional sources** listed in `workflows.additionalDirectories` (in `<dataRoot>/config.yaml`), in array order, each a machine-global collection root holding `<workflowKey>/` package directories;
- the **project source** under the project repository root, `<projectRoot>/.isagi/workflows/<workflowKey>/`, when the run has a project context.

A discovery pass scans each source once and builds a single request-scoped snapshot keyed by `workflowKey`: the last source that declares a key owns it, and any lower-priority packages for that key are retained only as shadowed provenance. The snapshot is never cached across requests — descriptor listing and every start recompute it — so a filesystem change between listing and start is always seen. Ownership never falls back because the owner is broken: if the winning package is a file, symlink, stale, corrupt, unverified, or otherwise invalid, that key fails and the shadowed lower-priority packages are never loaded in its place. The runtime logs a diagnostic naming the winning and shadowed package directories when a higher-priority source shadows a lower one, so "why did my global edit not apply?" has a support trail.

Package validity is never checked at runtime startup. It is checked when descriptors are listed and again immediately before a run starts; a failed start creates no run. A source that cannot be scanned — a path that is a regular file, is unreadable, or otherwise cannot be listed — fails the entire discovery pass instead of returning a partial overlay, because a requested key's true owner cannot be known from an incompletely observed chain. A missing configured directory is not a scan failure: it is skipped and warned once per normalized path, while missing built-in data-root and project roots are ordinary empty states and never warn.

Descriptor listing returns one result per discovered key and evaluates only the winning candidate. A successful descriptor does not expose which source supplied it. A failed package descriptor may still be returned in an otherwise successful listing, carrying the winning and shadowed package directories as framed diagnostics, so one broken key never hides the rest. A source that cannot be scanned is different: the descriptor request fails as a whole, and its API diagnostic may identify the failing collection root. The command palette presents the former as a per-key failure and the latter as a workflow-inventory failure.

Every workflow directory is an independent package with authored code under `src/`, tests under `tests/`, exact SDK/verifier/esbuild pins, and a verified `dist/index.js` plus `dist/isagi-workflow-build.json`. The package owns compilation and quality through its canonical scripts. After the author builds it, the verifier owns isolated import, export/`command()` validation, source and artifact fingerprinting, and build-receipt creation. The runtime validates and imports that verified artifact; authoring tooling is outside the runtime contract.

Discovery is on demand. The runtime recomputes the receipt's source and artifact identities,
validates the manifest format, workflow contract, canonical package identities, and internally
consistent exact pins, then copies the verified artifact bytes to
`<dataRoot>/workflow-artifacts/<artifactSha256>/index.mjs`. It imports that immutable copy rather
than the mutable package path. No generated content is written below a project workflow root.
Source-only, stale, corrupt, incompatible, or otherwise unverified packages remain discoverable as
broken descriptors but cannot run.

New runs use the newest winning verified package. The validated artifact hash is persisted on the
run in the same database transaction that creates it; cache publication happens first, and an
unreferenced immutable entry is retained if run creation later fails. Every callback for that run,
including retries and continuation after a runtime restart, reloads by the persisted hash. Cached
bytes are rehashed before import and the export shape is revalidated. Missing or corrupt pinned
artifacts fail closed without falling back to the latest package. A run without a persisted artifact
pin is unsupported and fails closed. The runtime performs no cache eviction today; future collection
must derive liveness from durable run pins.

Starting a workflow is an explicit-context operation. The caller supplies `worktreeId`,
`surfaceId`, and optionally `paneId`; the runtime resolves `worktreePath` and the originating
`agentSessionId` for `launchCtx`. There is no fallback to persisted active context. A workflow run
persists only the launch facts the runtime orchestrates on (`worktree_id`, `surface_id`); other
launch facts are workflow-owned and should be folded into opaque state by `init`.

Start flow (`startWorkflowRun`):

1. Resolve the worktree's project and fully validate/cache the winning workflow package.
2. Resolve `launchCtx` from explicit ids (validating worktree, surface, and any pane/agent-session
   binding).
3. Run `command(launchCtx)` to obtain the manifest title.
4. For a root run, reject if the launch has no surface (`workflow_root_surface_required`) or if the
   surface already has a root run (`workflow_surface_busy`). The check (`findLatestRootRunForSurface`)
   matches the latest root regardless of status, so even a terminal `done`/`failed` root blocks a new
   start until it is cleared.
5. Run `validate(launchCtx, variables)`. A thrown error rejects the start and creates no row.
6. Run `init(launchCtx, variables)` and create a `ready` row with `state_json` and the validated
   artifact hash.
7. Append the `started` lifecycle event and poke the dispatcher.

Child workflows follow the same flow with a `parentRun`: `worktreeId` is derived from the parent,
`surfaceId` from the parent (or an explicit override on the same worktree), and `rootRunId` from
the parent's tree. A child is a new run and therefore resolves the newest winning verified artifact;
after creation it continues from its own persisted pin like every other run. Child-start is an
**engine-owned callback** injected into the `ctx` (not a capability), which keeps
`WorkflowCapabilities` free of a dependency on the engine.

## The author SDK: `ctx` verbs and `wait`/`event` helpers

Workflow callbacks are trusted, in-process, and unsandboxed user code. They run with normal Node
power and the full `ctx` surface; backend interaction should go through `ctx` verbs, while plain
Node file and process work remains available. This is a deliberate trust model, not a containment
boundary.

Callbacks are plain async TypeScript; the engine runs the whole step inside `Effect.tryPromise`, so
each `ctx` verb is a **Promise-returning** crossing of the Effect→Promise boundary. A rejected verb
Promise becomes a thrown step, which the engine records as a `failed` run.

### The `ctx` verbs

The action surface is `worktreePath` plus eight verbs (`WorkflowContext` in
`packages/workflow-sdk/src/index.ts`):

- **`spawnAgentSession({ harness, prompt?, modifiers?, model?, effort? })` →
  `{ agentSessionId, sentAt, paneId }`.** This verb may take a couple of seconds.
  It adds an agent pane to the run's captured surface, waits for the PTY to come live and produce
  initial startup output, gives the TUI a fixed settle window, stamps `sentAt`, sends the **rendered
  seed text** (see Prompt input and modifiers), then waits for the harness to capture launch
  metadata. Existing startup waits are
  bounded (~10s) and time out into a `failed` run rather than hanging the dispatcher. Harness
  metadata is launch/discovery state, not workflow turn identity. The return value doubles as an
  **agent-turn wait target**.
  - Placement is deterministic and runtime-owned: a single-pane surface splits `right`; otherwise
    the runtime descends to the last leaf of the layout tree and splits it `down`, so repeated
    agent panes stack in the right/bottom region.
  - A missing run `surface_id` is a hard verb failure. Workflows never create surfaces.
- **`sendAgentPrompt({ agentSessionId, prompt?, modifiers? })` → `{ agentSessionId, sentAt }`.** A
  runtime-internal, backend-direct PTY write independent of any frontend attachment. It resolves the
  target session's harness and renders the prompt input first, then waits for the observer's
  empty/current baseline, resolves the current PTY incarnation, and reads the harness turn edges —
  rejecting if any `turn_started` is unmatched (the **quiescence guard**), so injection only happens
  at quiescence. It captures `sentAt` immediately before the bracketed-paste + Enter write and
  returns the provider-agnostic **agent-turn wait target**, so authors write:

  ```ts
  const sent = await ctx.sendAgentPrompt({ agentSessionId, prompt });
  return suspend(nextState, wait.agentTurn(sent));
  ```

- **`closePane(paneId)`** — closes a pane on the run's captured surface. If it is the last pane the
  surface is deleted; workflow authors should close panes they spawned, not the originating pane.
- **`getConversationHistory(agentSessionId)`** — role-tagged message text from the durable agent's
  current harness conversation. Runtime resolves provider identity internally from captured
  metadata; workflow code never stores or supplies a harness session id.
- **`runHeadlessAgent({ prompt?, modifiers?, harness, model?, effort?, timeoutMs? })` →
  `{ opId, launch }`.** Launches a trusted, agentic, non-interactive harness run in the worktree cwd
  and returns immediately. `launch.timeoutMs` is normalized before return so workflows persist a
  self-contained wait condition. The prompt input is rendered once before launch and stored as the
  required, already-rendered `launch.prompt`; reissue after a runtime restart replays that stored
  text without re-applying modifiers, so recovery cannot reinterpret the operation under later
  rendering rules. The op result is a normalized output transcript
  (`{ opId, status: 'completed' | 'failed', output?, error?, exitCode? }`), not a conversation
  history. Headless prompts are not sandboxed or forced read-only — read-only/idempotent use is an
  author contract.
- **`startWorkflow(workflowKey, variables?, context?)` → `runId`.** Starts a child run in the
  parent's tree (see Loading and invocation). The only link is the parent choosing to suspend on the
  returned `runId`; a child that later fails is delivered through a `workflow` JOIN result, not an
  automatic parent failure.
- **`log(level, message)`** — appends a `log` event (`debug`/`info`/`warning`/`error`) to the run's
  client event stream.
- **`setUiFeedback({ kind?, phase?, message? })`** — appends a `ui_feedback` event to the client
  event stream; `kind` defaults to `info` before persistence.

### Prompt input and modifiers

The three prompt-producing verbs — `spawnAgentSession`, `sendAgentPrompt`, and `runHeadlessAgent` — share one input from the SDK: an optional `prompt` plus optional `modifiers`. A modifier is a semantic request, `{ kind: 'skill', name }` or `{ kind: 'command', name }`, where `name` is the author's asset name, never a pre-rendered token. One pure renderer (`renderWorkflowPrompt` in `apps/runtime/src/workflows/prompt-renderer.ts`) validates the input, asks the selected harness definition for each token, and returns the rendered string that the existing interactive or headless transport then submits. Isagi guarantees deterministic validation, rendering, and submission — not asset availability, discovery, stacking capability, or successful native interpretation.

The renderer enforces a fixed set of rules:

- `modifiers` is optional and behaves as an empty array when omitted. Skills stack in caller order with no framework count limit; the workflow author owns whether the selected harness or an installed extension actually stacks them, regardless of native support.
- A command must be the sole modifier. A command mixed with any skill, or a second command, is rejected.
- `prompt` is optional. A whitespace-only prompt normalizes to absent, but a non-whitespace prompt is preserved by the renderer, not trimmed or rewritten.
- An input with no modifiers and no non-whitespace prompt is rejected before any pane, PTY, or headless process is created.
- Modifier names must be non-empty, contain no whitespace or Unicode control/format characters, and omit a leading `/` or `$` sigil. Other punctuation, including namespaced `plugin:skill` names, is author-controlled and passes through unchanged.
- Rendered tokens keep caller order and are separated by one ASCII space. A present prompt is appended after one ASCII separator; modifier-only input has no trailing separator.

Preservation is renderer-scoped: the renderer never trims or rewrites prompt characters. Within Isagi, interactive prompt content is normalized only from CRLF to LF before bracketed-paste framing (`writePromptToPty` in `apps/runtime/src/workflows/capabilities.ts`).

Structural validation failures surface as `WorkflowPromptInputError` — a runtime-internal tagged diagnostic, not an SDK export or a value authors branch on. It carries one of three coarse reasons: `invalid_prompt` (a non-string prompt), `invalid_modifier` (a non-array, malformed, mixed, repeated-command, or unsafe-name modifier), or `empty_input` (no effective prompt or modifier). Each verb catches this expected error and rejects, which the engine records as a `failed` run.

Validation and rendering precede operational side effects, but the exact point differs per verb: `spawnAgentSession` and `runHeadlessAgent` render before allocating the pane/PTY or launching the process, while `sendAgentPrompt` first resolves the durable session's harness, then renders before the observer/quiescence baseline, PTY resolution, and write.

Harness token syntax (the renderer tests are the behavioral authority):

| Harness    | `{ kind: 'skill', name }` | `{ kind: 'command', name }` |
| ---------- | ------------------------- | --------------------------- |
| `pi`       | `/skill:<name>`           | `/<name>`                   |
| `opencode` | `/<name>`                 | `/<name>`                   |
| `claude`   | `/<name>`                 | `/<name>`                   |
| `codex`    | `$<name>`                 | `$<name>`                   |

Only Pi renders a skill (`/skill:<name>`) differently from a command (`/<name>`). Claude and Codex have no native command or prompt-template concept, so a command modifier deliberately renders the same token as a skill; authors who need first-class command semantics must choose `pi` or `opencode`. This is generic per-harness rendering, not asset-name detection.

Compact call shapes:

```ts
// plain prompt
await ctx.sendAgentPrompt({ agentSessionId, prompt: 'Review the diff.' });
// modifier-only command
await ctx.spawnAgentSession({
  harness: 'pi',
  modifiers: [{ kind: 'command', name: 'isagi-docs' }],
});
// stacked skills with a prompt
await ctx.spawnAgentSession({
  harness: 'claude',
  modifiers: [
    { kind: 'skill', name: 'plan' },
    { kind: 'skill', name: 'review' },
  ],
  prompt: 'Implement phase 2.',
});
// object-form send
await ctx.sendAgentPrompt({
  agentSessionId,
  modifiers: [{ kind: 'skill', name: 'review' }],
  prompt: 'Focus on auth.',
});
```

`isagi-docs` is invoked with `{ kind: 'command', name: 'isagi-docs' }` on every harness: the generic command renderer produces `/isagi-docs` for Pi, OpenCode, and Claude, and `$isagi-docs` for Codex. Whether the invocation resolves depends on the corresponding installed asset — the Pi or OpenCode `isagi-docs` router, or the Claude or Codex `isagi-docs` skill — not on any renderer special case or availability check.

Submission is best-effort; native harness behavior stays authoritative once the text is submitted. One case is worth calling out: headless OpenCode's current plain `run` transport may submit slash-looking text as ordinary model prompt text instead of invoking the native command endpoint. Isagi's rendering and submission guarantee still holds even there; the native interpretation does not.

A spawn or send return value is the agent-turn wait target for the supported normal path — an ordinary prompt, one or more skills, or a command router that starts an agent turn. Isagi does not promise a resolvable turn for arbitrary operational or UI-only commands such as a harness's `/help` or `/model`; those are outside the workflow command-modifier contract, and pairing one with `wait.agentTurn` can wait indefinitely.

### The `wait` and `event` helpers

The SDK adds two minimal helper objects so authors never hand-write protocol literals:

- **`wait`**: `agentTurn(target)`, `userContinue()`, `userInput(questions)`, `workflow(runIds)`,
  `headlessAgent(ops)` — construct `WorkflowWaitCondition`s. `workflow` and `headlessAgent` accept
  one item or a non-empty array.
- **`event`**: `isUserContinue`, `isUserInput`, `isAgentTurnEnded`, `isAgentTurnFailed`,
  `requireAgentTurnEnded`, `requireAgentTurnFailed`, `getAgentTurnResult`, `getWorkflowResults`,
  `getHeadlessAgentResults` — narrow and assert on the resume `event` payload.

"Minimal" scopes the **helper families**, not the verb surface. There are deliberately no helper
families for conversation, launch context, variables, schemas, state summaries, or headless JSON
extraction. Conversation remains a direct `getConversationHistory` verb; only the extra helpers were
declined.

### Capabilities vs. context

Two runtime files back the `ctx`:

- **`WorkflowCapabilities`** (`capabilities.ts`) is the Effect-native service that owns the
  operational work: deterministic pane placement and startup settling, PTY writes, harness-metadata
  capture, headless launch, and event-ledger writes. It is the set of operations the engine may
  perform while executing a run — not an external SDK service and not a generic wrapper over every
  runtime capability.
- **`context.ts`** is a thin Promise adapter. It binds the current run and worktree path, exposes the
  SDK `WorkflowContext` verbs, and does only Effect→Promise boundary crossing and light author-facing
  argument shaping. It owns no operational detail.

**Cancellation tradeoff (v1):** verbs run via a detached root fiber (`Effect.runPromise`), so a long
`spawnAgentSession` poll or a pending `sendAgentPrompt` is _not_ interrupted when the engine scope
closes on shutdown. Acceptable here — the runtime owns these PTY/session resources regardless, and
the gate runs at concurrency 1.

## Waits in detail

Waits are physical facts on the summarized run: the run that suspends is the run that owns the wait.

### Agent-turn waits and the watermark

An `agent_turn` wait stores `{ agentSessionId, sentAt }`. The harness-observation layer emits
`turn_started` / `turn_ended` / `turn_failed` edges, each carrying internal `agentSessionId`,
`harnessSessionId`, `seq`, and `recordedAt` correlation facts.

- **Watermark (start-edge):** the wait is satisfied by the terminal edge (`turn_ended`/`turn_failed`)
  paired with the earliest `turn_started` for `agentSessionId` whose `recordedAt ≥ sentAt`. The gate
  is on the turn's **start**, not its end: a turn already in flight when the prompt was sent does not
  satisfy the wait even if it ends afterward. Once that first start is selected, later completed
  turns cannot steal the wait. One `findSatisfiedTerminalTurnEdge(condition, edges)` evaluator serves
  both the live bus path and the reconcile path, using internal harness id plus opening `seq` for
  exact pairing (else chronological legacy-failure pairing). The resume payload carries the matched
  terminal edge: `{ outcome: 'ended' | 'failed', recordedAt, reason? }`; the `event` helpers narrow it.
- **Provider identity stays internal:** metadata can be null for a fresh session or stale after a
  harness-level reset such as `/new`. The first provider-native start after submission establishes
  the stream being driven. Resetting or switching the underlying harness conversation while that
  workflow-controlled turn is active is unsupported; Isagi does not transfer the wait to a later
  conversation. There is intentionally no inferred completion or new start timeout.
- **Orphaned turns** — a turn that can never naturally end — are surfaced as synthesized
  `turn_failed` edges so a waiting run wakes instead of hanging: `new_start_supersedes` (a new
  `turn_started` arrives while a previous turn is still in flight) and `session_died` (an in-flight
  turn whose PTY incarnation is gone). Both use the orphaned turn's own `turn_started.recordedAt`, so
  live and read paths produce equivalent edges.

The reconcile path reads edges through `HarnessLedgerObserver.getTurnEdges(agentSessionId)` — a pure
read that returns the full derived stream including synthesized failures — so the engine never
derives harness edges itself. Because a workflow sends only at quiescence, the next turn to _start_
after `sentAt` is unambiguously the workflow's turn.

### Headless-agent waits

`headless_agent` waits are JOINs over one or more `{ opId, launch }` ops. The in-memory tracker owns
the live PTY process id, output capture, timeout, and result. When an op reaches a terminal result it
publishes an internal event; the resolver wakes the run only when every joined `opId` is terminal.
The resume payload is `{ kind: 'headless_agent', results }`, preserving partial success/failure.
Tracker entries are reaped once consumed; when a run reaches a terminal state, every still-tracked op
for that run is cancelled and unpinned so a headless prompt cannot keep mutating the worktree after
its owning run is dead.

### Workflow waits

`workflow` waits are JOINs over one or more child `runIds`. They resolve only after every referenced
child run is terminal (`done` or `failed`). The resume payload preserves input order:
`{ kind: 'workflow', results: [{ runId, status, result? | error? }] }`. A **failed child does not
auto-fail the parent** — the parent reducer inspects the results and decides. Missing referenced run
ids fail the waiting parent loudly, so it can never wait forever on a row that can never terminate.

### Human waits

Human waits are long waits resolved by explicit operator actions.

- **`user_continue`** stores `{ kind: 'user_continue' }`; `advance(runId)` wakes it with
  `{ kind: 'user_continue' }`.
- **`user_input`** stores `{ kind: 'user_input', questions }`; `advance(runId, answers)` validates
  answers against the persisted questions, applies defaults, and wakes with
  `{ kind: 'user_input', answers }`.

Validation is strict and runtime-owned. A rejected submission leaves the run waiting. A duplicate
`advance` that arrives after the run has already moved on is reported as **already resolved**, not a
failure.

Note on lifting: the child run owns its human wait. A **root summary** may _lift_ a non-paused child
`user_continue`/`user_input` gate into `blockingWait` so the operator can see and satisfy it — that
is projection behaviour (see The run API, The client boundary), not a wait mechanic.

### Arm-time reconcile

After persisting a `suspend` on `agent_turn`, `headless_agent`, or `workflow`, the engine
immediately re-checks the just-armed wait against durable truth. This closes the race where the wake
signal (a terminal turn edge, a fast headless op, a child finishing) lands in the window between the
step returning and the `waiting` row being persisted.

## The run API and controls

Routes are versioned under `/api/v1`. Success responses are enveloped `{ data, meta: { requestId } }`;
workflow rejections map to API code `workflow_rejected` with the engine reason in `data.reason`.
Request/response schemas are authoritative in `packages/contracts/src/workflows/api.ts` and
`types.ts`; the inventory below is method + path + purpose, not a schema transcription.

**Reads / discovery**

| Method | Path                                                       | Purpose                                                                                                      |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| POST   | `/workflows/descriptors`                                   | List workflow command descriptors for a launch context (POST for a contextual body; a read, not a mutation). |
| GET    | `/workflows/runs?surfaceId=&worktreeId=&status=&rootOnly=` | List run summaries. `rootOnly` defaults to `true`.                                                           |
| GET    | `/workflows/runs/:runId`                                   | Get one run summary.                                                                                         |
| GET    | `/workflows/runs/:runId/events?includeChildren=`           | Replay the client event stream. `includeChildren` defaults `false`; capped to the most recent 1000 events.   |

**Mutations**

| Method | Path                             | Purpose                                                    |
| ------ | -------------------------------- | ---------------------------------------------------------- |
| POST   | `/workflows/runs`                | Start a root run.                                          |
| POST   | `/workflows/runs/:runId/pause`   | Pause a root run tree. **Root-only.**                      |
| POST   | `/workflows/runs/:runId/resume`  | Resume (unpause) a root run tree. **Root-only.**           |
| POST   | `/workflows/runs/:runId/clear`   | Cancel/delete a root run tree. **Root-only.**              |
| POST   | `/workflows/runs/:runId/retry`   | Retry a failed root run. **Root-only.**                    |
| POST   | `/workflows/runs/:runId/advance` | Satisfy a human wait. **Run-scoped** — may target a child. |

**Stream**

| Method | Path                                                    | Purpose                                        |
| ------ | ------------------------------------------------------- | ---------------------------------------------- |
| WS     | `/workflows/runs/:runId/events-stream?includeChildren=` | Live client event stream (see Event surfaces). |

Notes:

- `pause`/`resume`/`clear`/`retry` require a root run id; a child id is rejected with
  `workflow_root_run_required`. `retry` additionally requires a `failed` root
  (`workflow_run_not_failed`) and deliberately retains the run's artifact pin. Verifying changed
  workflow code affects new runs, not a retry of an existing run; clear and start a new run to use
  the new artifact.
- `clear` is `POST`, not HTTP `DELETE`, because it requests **async cancellation** when a step is
  running (the running step finishes, then its tree is reaped); otherwise it deletes the tree
  immediately.
- `advance` is the one run-scoped control: it targets the specific waiting run, which is often a
  **child** (`prompt.runId` / `blockingWait.runId`).
- Control mutations respond with `{ runId, status }`.

The `WorkflowRunSummary` contract exposes: `runId`, `rootRunId`, `parentRunId`, `workflowKey`,
`title`, `status`, `paused`, `waitKind`, `blockingWait`, `worktreeId`, `surfaceId`, `uiFeedback?`,
`prompt?`, `error?`. For a root summary, `runId === rootRunId` and tree facts are aggregated by the
projection. The contract exposes **no display status** — the client derives presentation.

## Event surfaces — three, don't conflate them

The subsystem has three separate "event" concepts. They live in different places and serve different
readers; keep them distinct.

1. **Reducer history — the `workflow_run_events` DB table.** Append-only engine history: the initial
   state plus each reducer outcome (`cont`/`suspend`/`done`/`fail`) with a state snapshot and a small
   trigger. Internal debugging aid for hand-edited workflows; **never streamed to clients**; cascades
   on run delete.

2. **The client event stream — the per-run JSONL ledger.** The user-visible workflow log. A typed
   union `log | ui_feedback | lifecycle` (lifecycle ∈ `started`/`suspended`/`resumed`/`done`/`failed`),
   one JSONL file per run. It is exposed two ways, both capped to the most recent 1000 events: REST
   replay (`GET …/events`) and a **per-run WebSocket** (`…/events-stream`). The WS protocol is a
   handshake: the client sends `workflow_events_requested`, the server replies with a
   `workflow_events_snapshot`, then streams `workflow_event_appended` frames. `includeChildren`
   resolves the root (`rootRunId ?? runId`) and merges every run's events in the tree,
   chronologically — so a root log shows child-workflow events inline. `ctx.log` and
   `ctx.setUiFeedback` write here.

3. **Run-summary events — on the global runtime bus.** Coarse, per-_root_ summaries broadcast on the
   global runtime event socket (`/events`), distinct from the per-run stream in #2. `workflow_run_snapshot`
   (client-requested; carries root summaries), `workflow_run_changed` (its payload **is** a
   `WorkflowRunSummary`), and `workflow_run_cleared` (`{ runId: rootRunId, rootRunId, surfaceId }`).
   `WorkflowRunProjection` derives, debounces, and de-duplicates these from repository/ledger signals.
   These payloads carry `WorkflowRunSummary` by contract; the client caches them (see The client
   boundary). The old `workflow_surface_*` events are removed, not bridged.

## Persistence

All run state lives in the `workflow_runs` table (`apps/runtime/src/persistence/schema.ts`). The
runtime owns the row; four columns carry structured JSON with distinct ownership rules:

- **`state_json`** — opaque workflow state. The runtime **never** introspects it.
- **`wait_condition`** (JSON) — the pending condition; the engine _does_ introspect it (the resolver
  queries it). Only `wait_kind` is an indexed column; the rest lives in the JSON, since
  `status='waiting' AND wait_kind='agent_turn'` already narrows the set and the condition is a
  per-kind tagged union.
- **`resume_payload`** (JSON) — "what woke you"; the resolver writes it, the step reads it (as the
  `event` arg), and the result write clears it.
- **`result_json`** (JSON) — terminal value written by `done(value)`. Separate from `state_json`:
  `state_json` is the reducer's current state, while `result_json` is the value other workflows can
  later join on.

Display feedback is **not** a `workflow_runs` column. `ctx.setUiFeedback` appends a `ui_feedback`
event to the per-run event ledger (Event surfaces #2), and a run summary's `uiFeedback` is projected
from the latest such event in the run tree (`error` is a column, holding the terminal failure payload).

The `workflow_run_events` table is the append-only reducer history described in Event surfaces
(#1); it references `workflow_runs` with `ON DELETE CASCADE` and is ordered by autoincrement `id`.

Each result write updates only the engine-owned lifecycle columns for that outcome (`status`,
`wait_kind`/`wait_condition`, `resume_payload`, `state_json`, `result_json`/`error`) and clears
`owner` on every result transition. `wait_kind` values are `agent_turn`, `user_continue`,
`user_input`, `workflow`, and `headless_agent`. `paused`
and `cancel_requested` are orthogonal flags, not lifecycle statuses. Indexes cover `status`,
`(status, wait_kind)`, `paused`, `worktree_id`, and `surface_id`; `rootOnly` listing narrows on
`parent_run_id IS NULL`.

Expected failures surface as the tagged `WorkflowEngineError`. Control-relevant reasons include
`unknown_workflow_key`, `workflow_load_failed`, `worktree_not_found`, `surface_not_found`,
`surface_worktree_mismatch`, `pane_not_found`, `agent_session_not_on_surface`,
`workflow_launch_context_mismatch`, `validation_failed`, `workflow_root_surface_required`,
`workflow_surface_busy`, `workflow_root_run_required`, `workflow_run_not_found`,
`workflow_run_not_failed`, `workflow_wait_not_satisfiable`, and `workflow_user_input_invalid`.

## The client boundary

- **Run store** (`apps/web/src/lib/workspace/workflow-runs.ts`): `runsById: Record<runId, WorkflowRunSummary>`
  plus `rootRunIdBySurfaceId: Record<surfaceId, rootRunId>` (only root runs with a surface are
  indexed). The store is bootstrapped by requesting `workflow_run_snapshot` on connect, and updated by
  `workflow_run_changed` (upsert) and `workflow_run_cleared` (delete, preserving unrelated surface
  indexes). The denormalized surface index is intentional — active-surface lookup is hot and
  product-critical.
- **Presentation derivation** (`workflow-derive.ts`): `paused → 'paused'`; else
  `blockingWait.kind ∈ { user_continue, user_input } → 'waiting_user'`; else `failed` / `done` /
  `driving`. `paused` takes precedence. Production web code reads `blockingWait`, **not** the
  summary's `waitKind`: cross-tree gate aggregation lives only in `blockingWait`, while `waitKind`
  stays the summarized physical run's own wait and is never aggregated. Surface attention prefers the
  root run's derived state over aggregated pane/source attention.
- **Action targeting** (`WorkflowBarContainer` / `WorkflowBar`): the bar renders the **root** summary
  of the active surface. `pause`/`resume`/`clear`/`retry` target `summary.rootRunId`; `advance`
  targets `prompt.runId`, which may be a **child** run. The root log stream is opened with
  `includeChildren=true` anchored on `rootRunId`.

## Key decisions and rationale

- **Durable state machine, snapshot-at-suspension, not Temporal replay** — for edit-resilience and a
  natural non-linear phase flow. (The decisive tradeoff of the whole subsystem.)
- **DB is the source of truth** — the row _is_ the run; any in-memory queue/poke is only a latency
  optimization, so restart-survival falls out by construction.
- **Run-centric identity** — `runId` is canonical; a surface is a projection input and display
  target, not the owner of controls, logs, or identity. Controls are root-scoped; only `advance`
  is run-scoped.
- **State is opaque to the runtime** — decouples the runtime from workflow-internal schema and
  strengthens edit-resilience.
- **Capabilities/context split** — Effect-native `WorkflowCapabilities` owns operational work; the
  Promise `context.ts` only adapts. This lets future callers reuse capabilities without an external
  SDK/runtime-service junk drawer.
- **`paused` is an orthogonal gate, not a status** — status stays five values; pause gates dispatch
  and is surfaced in summaries/events.
- **`blockingWait` is the single cross-tree gate projection** — the web derives waiting-for-user from
  it; `waitKind` is never aggregated.
- **Verbs are fast; suspension is the return** — no hidden blocking verbs, so every wait is an
  explicit, serializable continuation.
- **No fast-effect durability in v1** — accept a rare double effect on mid-step replay rather than
  journal every activity; idempotency keys are the future lever.
- **User-gated resume** — agents don't auto-restart on a desktop app, so the recoverer parks runs and
  the user reopens + resumes; resume reconciles against durable truth.
- **No steady-state poll** — coalescing wake + drain-to-empty + a one-time boot drain.

## Current scope and deferrals

Shipped: the engine spine and SDK/loading foundation, including ordered workflow discovery across the data-root, configured additional, and project sources; the run-centric API and controls; the three event surfaces; `WorkflowRunProjection`; and the web surface — the run store, the workflow bar and surface glow, attention aggregation, and command-palette workflow entries with the input flow.

Deferred (tracked in the `agent-workflows` milestone):

- an **external / agent-harness-facing** "run a workflow" tool — palette and runtime-API invocation
  are shipped; a harness-facing tool is not;
- idempotency keys for fast intra-step effects;
- config-source reload / `Reload Configuration` for `.isagi/config.yaml`;
- precise command-arg-to-variable type inference;
- richer workflow-controlled pane placement;
- an automated `kill -9` crash harness (the engine is durable-by-design and was verified via the
  `workflow_runs` row/logs, the automated suite, and a manual real-agent run).

Known residual simplification candidate: the client event-stream WebSocket requires the client to
send `workflow_events_requested` before the server sends the snapshot. This handshake is documented
as current behaviour and flagged as a future simplification, not a bug.

## Where the code lives

- `packages/workflow-sdk` — author-facing types, wait-condition shapes, static question types, launch
  context and command manifest types, conversation types, `defineWorkflow`, the result constructors,
  and the `wait`/`event` helpers.
- `apps/runtime/src/workflows/` — the engine: `types.ts` (runtime-only row/status/error shapes),
  `capabilities.ts` (Effect-native `WorkflowCapabilities`), `context.ts` (the Promise adapter),
  `loader.ts`, `registry.ts`, `repository.ts`, `resolver.ts`, `resume-paths.ts`,
  `wait-conditions.ts`, `user-input.ts`, `run-failure.ts`, `headless.ts`, `event-ledger.service.ts`
  (the client event stream), `workflow-run-projection.service.ts` (`WorkflowRunProjection`),
  `workflow-engine.service.ts` (the loops + start/controls), and `api.ts` (the run API + WS stream).
- `packages/contracts/src/workflows/` — `api.ts` (route contracts) and `types.ts` (run summary,
  event, and control schemas).
- `packages/contracts/src/runtime-events/` — the `workflow_run_*` runtime-bus event schemas.
- `apps/runtime/src/persistence/schema.ts` — the `workflow_runs` and `workflow_run_events` tables.
- `apps/runtime/src/agent-sessions/harness/` — turn-edge derivation (`turns.ts`), the observer and
  `getTurnEdges` (`observer.service.ts`), conversation reads (`conversation.ts`).
- `apps/web/src/lib/workspace/` — `workflow-runs.ts` (the run store), `runtime-events.ts`
  (`workflow_run_*` handling), `workflow-derive.ts` (presentation derivation), and
  `workflow-events/stream.ts` (the per-run event-stream client); `apps/web/src/routes/workspace/`
  hosts `WorkflowBarContainer`, `WorkflowBar`, `Surface`, and `WorkflowSurfaceGlow`.

Related ADRs: 0001/0008 (state ownership and read composition), 0003 (web actions target explicit
runtime identifiers), 0004 (localized action feedback), 0005/0006 (durable agent session over
disposable PTY incarnations), 0007 (per-invocation harness instrumentation). Shaping history for this
subsystem lives in the `agent-workflows` milestone's planning notes.
