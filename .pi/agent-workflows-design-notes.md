# Agent Workflows — Design Notes & Reference

Reference material from the shaping brainstorm (2026-06-21). **Reference, not source of
truth.** These are the decisions, sketches, and findings from shaping; each task will refine
them in its own brainstorm. Code and `file:line` references are accurate as of shaping — the
code moves, so re-verify before relying on them. The point is so future brainstorming
sessions don't reinvent the wheel.

---

## 1. The problem (value)

The user runs a repeatable meta-workflow with agents: milestone → tasks → per-task brainstorm
→ phase-wise plan → a loop where, for each phase, an **implementation agent** pushes back on
the plan (asks questions, raises concerns), the user routes those to a **planner / brainstorm
agent** via a template, the planner adjudicates (it holds the rationale and decides on the
user's behalf), replies "no flags" or escalates a real flag; copy-paste back and forth until
aligned, then implement; commit per phase; then a review loop after all phases.

The judgment is already delegated to the planner-as-watchdog (escalates only on a flag); what
remains is hours of mechanical message-routing. That routing is what we automate.

Insights that shaped everything downstream:

- **The copy-paste is not load-bearing for awareness.** The user doesn't read it — the
  planner agent's escalation template *is* the awareness channel. So automating the routing
  doesn't lose situational awareness.
- **Two agents because phases are big.** One agent's context window degrades on a big phase;
  the planner holds rationale/history, the impl agent is fresh per phase.
- **It's distributed cognition with an adjudicator, not a lossy handoff.** The impl agent's
  fresh questions actively surface the missing 20–30% the plan didn't capture; the planner
  answers because it knows the *why*. Just handing the planner's transcript to the impl agent
  is worse (messy, context-heavy, lossy if summarized) — so we keep the Q&A loop.
- **Ambition:** automate the 2–3 hrs of manual routing so it runs while asleep; push toward
  higher autonomy as agents and review systems improve.
- **Rails / engines / switchman:** the code workflow is deterministic *rails*; agents are
  stochastic *engines*; the human is the *switchman* at junctions. Determinism in the
  mechanical parts, stochasticity only at judgment points. This is why workflows are **code
  reducers**, not an orchestrator agent (which would re-roll the dice on the plumbing).

## 2. Architecture at a glance

- Workflows are user-authored `callback.ts` reducers in the data root (trusted, in-process).
- The runtime executes them as **durable state machines** that survive runtime restarts.
- **Runtime-owned; the client/UI is a projection.** State is opaque to the runtime; all
  observable effects go through `ctx`.
- Built on **Effect**, in-process, **no external workflow library, no separate process**
  (i.e. not Temporal-the-service).

## 3. The execution model

- A workflow is a reducer / `step` function over an explicit, serializable **state object**.
- Between suspensions the reducer runs synchronously and `await`s **fast activities** inline
  (`ctx` calls).
- To wait on a long external event it **returns** `suspend(nextState, condition)` — it does
  *not* inline-`await` the long thing.
- `cont(nextState)` = persist + mark the row **ready** so the next dispatcher tick re-runs it
  (an internal transition, no external wait). `cont(s)` ≡ `suspend(s, { Now })` — same
  mechanism, distinct verb for intent. *(Engine-spine refinement: a `cont` round-trips through
  the DB + dispatcher; it does **not** step inline in the same fiber — see §12.)*
- **`suspend` persists the *waiting* state** (e.g. `phase: 'await_verdict'`) plus the
  condition. When the event fires, the engine runs `step(waitingState, event)`, which computes
  the **real next state from the event payload** (e.g. the agent's reply text → branch flag vs
  no-flag). The next state is *computed, not predetermined*, because it depends on what the
  agent said.
- **Each `await_*` phase is a named, serializable continuation.** The phase enum is the set of
  continuations. This is why state must be explicit — you can't serialize a closure across a
  restart — and why the reducer is shaped this way.
- **The one rule:** inside a step, `await` fast activities inline (read / inject / spawn /
  commit / setPhase); to wait for a long external thing (agent turn, user input, sub-workflow,
  headless prompt), **return a `suspend`**.

## 4. Reference code — the implementation workflow as a durable state machine

Illustrative sketch from shaping (not a final API). This is the reference for both the engine
shape (`agent-workflows-engine-spine`) and the workflow itself (`agent-workflows-reference-workflow`).

```ts
type State = {
  phase: 'spawn_impl' | 'await_impl' | 'await_verdict' | 'await_user_flag'
       | 'implementing' | 'review_gate' | 'next_phase' | 'done'
  planPath: string
  brainstormId: SessionId    // the existing planner agent (from ctx context)
  phaseCount: number
  currentPhase: number
  implId?: SessionId         // per-phase implementer
  reviewMode: boolean
}

// runs to the next suspension, then returns.
// suspend(state, condition) = persist + wait;  cont(state) = persist + step again now.
async function step(ctx, s: State, event?: Event) {
  switch (s.phase) {

    case 'spawn_impl': {
      const implId = await ctx.spawnSession({ pane: `impl-${s.currentPhase}`,
                                              seed: seedPrompt(s.planPath, s.currentPhase) })
      return suspend({ ...s, implId, phase: 'await_impl' }, { turnComplete: implId })
    }

    case 'await_impl': {                       // woken by the impl agent's turn
      const msg = event.message
      if (isAligned(msg)) {
        await ctx.inject(s.implId!, GO_IMPLEMENT)
        return suspend({ ...s, phase: 'implementing' }, { turnComplete: s.implId! })
      }
      await ctx.inject(s.brainstormId, reconcileTemplate(msg))
      return suspend({ ...s, phase: 'await_verdict' }, { turnComplete: s.brainstormId })
    }

    case 'await_verdict': {                    // woken by the planner's turn
      const verdict = event.message
      if (hasFlag(verdict)) {
        await ctx.raiseAttention(`Planner flagged phase ${s.currentPhase}`)
        return suspend({ ...s, phase: 'await_user_flag' }, { userContinue: true })
      }
      await ctx.inject(s.implId!, verdict)
      return suspend({ ...s, phase: 'await_impl' }, { turnComplete: s.implId! })  // loop back
    }

    case 'implementing': {                     // woken when impl finishes
      await ctx.commit(`phase ${s.currentPhase}`)
      return s.reviewMode
        ? suspend({ ...s, phase: 'review_gate' }, { userContinue: true })
        : cont({ ...s, phase: 'next_phase' })
    }

    case 'next_phase': {
      const n = s.currentPhase + 1
      return n > s.phaseCount ? cont({ ...s, phase: 'done' })
                              : cont({ ...s, currentPhase: n, phase: 'spawn_impl' })
    }
    // await_user_flag, review_gate, done … elided
    // init (discover phaseCount via plan-file read or a headless prompt) elided
  }
}
```

The `reviewMode` knob is just whether `implementing` routes through a `review_gate`
suspension — the entire "stop after every phase for me" feature is one branch, zero engine
changes. A flag escalates by suspending on `userContinue` after `raiseAttention`.

## 5. The condition union (what a run suspends on)

```ts
type Suspend =
  | { _tag: 'TurnComplete'; sessionId: SessionId; after: Watermark } // a turn finishing past `after`
  | { _tag: 'UserContinue' }                                         // the "continue workflow" button
  | { _tag: 'UserInput' }                                            // resume with user-provided text
  | { _tag: 'ChildWorkflowReturn'; runId: RunId }                    // a sub-workflow returns
  | { _tag: 'HeadlessResult'; opId: OpId }                           // an ephemeral prompt finishes
```

Sketch — standardize the shapes in the engine task. A suspended run is also expected to wake
on session **death/failure** (reuse the attention layer's killed/error), or it hangs forever
when a driven agent is killed.

## 6. Durability model — snapshot-at-suspension (NOT Temporal replay)

**Same as Temporal (unavoidable):** to keep completed side-effects from re-running on
recovery, you record activity results and skip them on re-entry.

**The actual delta (one thing):** where control state lives and whether you replay history.

- *Temporal:* holds no explicit state — reconstructs `phase`/locals by **replaying the whole
  activity journal from t=0** on every wake. Determinism required for the whole life; editing
  code breaks replay → versioning ceremony.
- *Ours:* holds state as an **explicit serialized object**; **never replays past phases**. On
  wake, `load(state)` and run one step. Any journal is bounded to the current segment.

**Why we chose it (three consequences):**

1. **Edit-resilience** — the user hand-edits workflows while runs are in flight; we never
   re-execute completed phases, so editing them can't corrupt recovery. (This is the decisive
   reason.)
2. **Determinism only within the current segment**, not the whole multi-hour life.
3. **Inspectable/migratable state** in principle (though the runtime keeps it opaque — see §12).

**What you pay:** reducer discipline — anything crossing a suspension lives in `state`, not a
local variable. (Temporal lets locals survive awaits via replay; we give that up.)

**Worked crash walkthrough.** Crash during `await_verdict`, phase 2 (we injected the impl
agent's questions into the planner and are waiting on its turn). On disk:

```
{ state: { phase:'await_verdict', currentPhase:2, implId, brainstormId, planPath, … },
  pending: { turnComplete: brainstormId } }
```

On restart: load the row, re-arm "wake when `brainstormId` finishes a turn," reconcile against
the JSONL transcript (did the turn complete while we were down? deliver now, else wait). The
planner's turn lands → `step(state, event)` → continue. **No re-spawn, no re-inject, no re-run
of phase 1.** Temporal reaches the same point by re-running `step` from phase-1 `spawn_impl`,
replaying the journal to rebuild `currentPhase=2` and `implId` — same result, but by replay
rather than load.

**Where durability / retry come from:**

- *Long waits (99% of wall-clock):* a suspended run is just a persisted `{state, pending}`
  row. Surviving a restart = the row survives. An agent turn's completion is observed by hooks
  and stored in the transcript — **the transcript IS the completion ledger**; reconcile
  pending waits against it on startup.
- *Fast effects within a segment:* **v1 has no durability** — on a mid-segment crash, re-run
  the segment and accept a rare double inject/spawn. Idempotency keys (keyed by
  `runId/phase/seq`) are the future lever if it bites.
- *Failures:* a failing activity is retried (Effect `Schedule`) or surfaced as an error event
  the reducer handles (→ error phase → `raiseAttention`).

## 7. The `ctx` SDK surface

**Taxonomy** — every workflow move is one of:

- *Reads (never suspend):* context (project / run / originating session);
  `getConversationHistory(session)` (role-tagged text; the workflow does `.at(-1)` itself).
- *Suspend-on-event:* `inject` → await turn-complete; `askUser` → await input;
  `waitForContinue` → await continue; `callWorkflow` → await return; `runHeadlessPrompt` →
  await result.
- *Spawn / fire:* `spawnSession` (visible pane) / `runHeadlessPrompt` (invisible);
  `setOperatingPhase`; `raiseAttention`.
- *Terminate:* return a value.

**Two species of agent interaction — don't conflate:**

- *Headless prompts:* invisible, ephemeral, one-shot reasoning ("how many phases?", "is this a
  flag?", the research router). Modeled as a **transient subprocess + suspendable
  `HeadlessResult` op**; re-issued on restart (pure reasoning, safe). **Not** a durable
  session — no GC concern.
- *Supervised sessions:* long-lived panes you can enter and talk to (the planner / impl
  agents). The workflow spawns, injects, awaits turns.

**Verb notes:**

- `inject` = a pty write (**exists today** — `pty.service.ts:246`). Shares the channel with
  the human keyboard → arbitrated by surface lockdown (§11).
- `spawnSession` = wraps existing session + pane creation; **seed via the launch envelope**
  (initial-prompt arg) to avoid the harness-not-ready race; can be paneless for headless.
- `runHeadlessPrompt` = **net-new**: a non-interactive `HarnessAdapter` launch envelope +
  stdout capture. Each harness has its own print mode (verify Pi).
- `getConversationHistory` = one read; text only, no tool calls.
- `ctx`-call **is** the activity — no formal `Activity` type yet (extensible later for
  external systems).

## 8. Turn detection & the watermark

- "Turn complete" = the working→waiting transition, detected from the **raw JSONL records**,
  not the live attention dot (which is process-liveness-gated and resets when the process
  dies — §10).
- New `turn_start` / `turn_end` events, **distinct** from the attention `agent_session_changed`
  poke. The bus event is a cheap "go re-check this session" doorbell; the JSONL is the truth;
  the per-harness observation module is the interpreter.
- **Watermark:** there is no turn id / sequence — only a string `recordedAt`. So stamp the
  injection time `T` and resume on the **first `turn_start ≥ T` then its `turn_end`** (this
  disambiguates from a previous in-flight turn's end). Ordering needn't be precise because
  `turn_start`→`turn_end` has a large LLM-latency gap. JSONL append position is a more robust
  monotonic key, but the current projection discards line offsets when it merges + sorts by
  `recordedAt` (`projection.ts:34`) — so the engine likely reads raw JSONL on resume.

## 9. Codebase findings (as of shaping)

**Exists to ride:**

- *Reactive event bus:* `apps/runtime/src/runtime-events/internal-event-bus.ts` — Effect
  `Queue` pub/sub with type-filtered `subscribe`. The attention service already publishes
  `{ type: 'agent_session_changed', agentSessionId }` on observed-state change
  (`attention-projection.service.ts:88`).
- *The JSONL completion ledger:* agent observation is **not** in SQLite — it's append-only
  JSONL artifact files per session, projected on demand
  (`readJsonlForAgentSession` → `buildHarnessObservationProjection`, `harness-observation/projection.ts`),
  watched via `fs.watch` + 75ms debounce. Files survive restart.
- *Per-harness observation modules* (`agent-sessions/harness-observation/{claude,codex,pi,opencode}.ts`)
  normalize each harness to idle/working/waiting/error. Reuse/extend for turn-edge detection:
  - Claude: `Stop` → waiting; `StopFailure` → error; `Notification` idle_prompt → waiting (`claude.ts:9-16`).
  - Codex: `Stop` → waiting; `UserPromptSubmit` → working (`codex.ts:9-12`).
  - Pi: `agent_start` → working; a `pending` boolean (false → waiting); **no `Stop` wired today** (`pi.ts:9-15`).
  - OpenCode: `status` busy/idle/error (`opencode.ts:9-15`).
- *Persistence:* Drizzle SQLite (`persistence/schema.ts`), established "durable entity + runs"
  pattern (`agent_sessions`, `worktree_command_runs`). Add a **`workflow_runs`** table with
  opaque `state_json` + `pending` + status + `operating_phase` columns. The opaque column
  makes "the runtime never inspects state" true by construction.
- *Injection exists:* `pty.service.ts:246` (`attachment.write`), `pty-processes/api.ts:125`
  (`pty.write`). Same channel as the human keyboard.

**Net-new:**

- *Headless / non-interactive execution:* the `HarnessAdapter` interface has only
  `buildLaunch → LaunchPtyProcessInput` (`harness-adapters/types.ts:14-19`); **zero**
  non-interactive path. Net-new per harness.
- *Conversation TEXT capture:* observation extracts only `nativeEvent` + a raw `event` blob,
  never text. **Open question:** is the text already in the `event` blob (extraction) or does
  hook capture need extending per harness? Gates the routing reads.
- *`turn_start` / `turn_end` events:* not emitted today (only attention).

**ADR map:** 0007 (per-invocation harness integration — hooks/plugins/session-id capture;
best-effort; **needs updating** in the instrumentation task). 0005/0006 (disposable PTY /
durable worktree entities). 0001/0008 (state ownership, read composition). 0003 (palette).
0004 (action feedback).

## 10. Failure spots

- **No turn sequence id** — only string `recordedAt` → watermark fragility; mitigated by the
  injection-timestamp + `turn_start ≥ T` match (§8).
- **"waiting" conflates** turn-done with blocked-on-permission-prompt (Claude `idle_prompt`) →
  don't auto-inject blindly on "waiting."
- **The live attention dot is process-liveness-gated** — forced to idle/error when the PTY
  isn't running (`attention-projection.service.ts:415-443`), so a completed-then-exited turn
  reads idle → **resume off raw records, not the dot.** Records key off `harnessSessionId`,
  and a durable session spans multiple `harnessSessionId`s across resumes → the watermark
  hangs off the durable `agent_sessions.id`.
- **Best-effort instrumentation** (ADR 0007); Codex hook schema unproven; Pi weakest-
  instrumented → degraded/timeout paths must escalate, not hang.

## 11. Ownership, lockdown, controls

- Collision is acceptable in practice (the human knows not to type while the workflow runs),
  arbitrated cleanly by: a running workflow is **scoped to a surface**; the surface **locks
  input while the run is `running`** and unlocks on `waiting` / `done` / `failed`.
- **Run status drives the lock** (runtime owns status, web renders).
- **Controls:** `pause` (unlock + stop injecting), `cancel` (end the run), `continue` (resume
  from a waiting state).
- Headless ephemeral subprocesses are invisible/paneless — outside the surface, no locking.

## 12. Decisions log (with rationale)

- **Durable state machine, snapshot-at-suspension, not Temporal replay** — for edit-resilience
  + natural non-linear phase flow.
- **`ctx`-as-activity, no formal Activity type yet** — keep it light; extensible later for
  external (non-runtime) systems.
- **No fast-effect durability in v1** — re-run the segment; accept rare double-effect;
  idempotency keys later.
- **State opaque to the runtime (`state_json`)** — all observable state via `ctx`; decouples
  the runtime from workflow-internal schema; strengthens edit-resilience.
- **Runtime-owned, restart-surviving** — workflows run in the runtime (Electron is a client);
  "run while asleep" falls out for free.
- **Build on Effect, in-process, no library** — Temporal needs a separate service; we want
  embedded.
- **Headless in v1 as a transient suspendable op** (not a durable paneless session) — lighter,
  no GC concern.
- **Agent-facing tool in v1 (last)** — injection is easy (reuse the plugin/extension
  mechanism); the **return mechanism is deferred to dogfooding**. Options:
  (a) per-workflow blocking vs resumable flag; (b) two tools (spawn → returns id, then
  wait-on-id); (c) **async result-injection** — the tool returns a handle, the agent ends its
  turn, the workflow injects the result as a new turn (most native to our architecture,
  restart-robust). Leaning (c).
- **Surface lockdown for ownership/collision** — simplest arbitration.
- **Conversation capture: text only** (assistant/user), no tool calls/results.

**Engine-spine brainstorm refinements (2026-06-22) — the engine shape:**

- **Engine = durable work queue with three responsibilities** — *resolver* (promotes
  `waiting → ready` when a condition holds; harness-aware, in the weeds of turn-edge + JSONL),
  *dispatcher* (claims `ready` rows and runs one step each; harness/domain-agnostic workhorse),
  *recoverer* (boot-time sweep only). Replaces the earlier "event loop" framing. The resolver
  and dispatcher run at concurrency 1; a bounded worker pool (size > 1 later, = 1 for the gate)
  executes the steps the dispatcher claims. **DB is the source of truth; any in-memory
  queue/poke is only a latency optimization.**
- **One step return, uniform lifecycle** — every step returns `suspend(nextState, condition)`.
  The engine evaluates the condition once and sets the row `ready` (satisfied now) or `waiting`
  (arm the resolver). `cont(s)` is sugar for `suspend(s, alwaysReady)` and sets `ready` itself.
  *Refines §3:* a `cont` round-trips through the DB and is picked up on the next dispatcher
  tick — it does **not** step inline in the same fiber. Cost = one row-write + one scheduling
  hop per `cont`; negligible here (phase transitions are sparse, turns are minute-scale).
  **Discipline:** `cont` is for phase boundaries only; heavy iteration lives inside a step.
- **Row status lifecycle** — `waiting → ready → running → (waiting | ready | done | failed)`.
  A worker claims a row with an atomic `ready → running` flip stamped with the owner; only the
  winner runs it (prevents two workers stepping one run, which would corrupt its sequential
  state).
- **Recovery = boot sweep, not a fiber** — on startup, one transaction flips all
  `running → ready` (after `kill -9` any `running` row is orphaned by definition). No live-worker
  registry (it wouldn't survive the crash anyway). Leases/heartbeats are the deferred upgrade
  for the parallel era (pool > 1 / in-process fiber death).
- **Idempotency: not guaranteed in v1 (explicit trade-off)** — the recoverer re-runs in-flight
  steps, so a reclaimed step can double an effect (`inject`/`spawn`). Idempotency keys
  (`runId/phase/seq`) are the deferred lever. The gate never exercises this — its crash is
  mid-`waiting`, with no step executing.
- **Step failure ≠ worker death** — a thrown step is caught by the worker and the run is marked
  **`failed` (terminal)**, carrying error context for diagnosability; it is **not** auto-retried.
  v1 "retry" = start a fresh run (resuming a failed run is deferred); the retry affordance
  itself is the frontend task. The recoverer only touches orphaned `running` rows, never
  `failed`.

**Phase-2 brainstorm refinements (2026-06-22) — durability & resume:**

- **The bus is lossy across restart by design** (`observer.service.ts` `shouldEmit = Boolean(existing)`):
  the first reconcile in a fresh process rebuilds turn-status baselines *without* re-publishing
  pre-crash edges. A resumed run therefore never receives a replayed `turn_ended` — resume must
  **read the projection/ledger and evaluate the condition itself**, never wait for an event.
- **Watermark = start-anchored on `recordedAt`.** Persist inject time `T`; the wait is satisfied by
  the first `turn_started` with `recordedAt ≥ T`, then its paired `turn_ended` (success) or
  `turn_failed` (death/error → reducer decides). `seq` (`projection.ts`) is a per-`harnessSessionId`
  array index recomputed each projection — **not** a durable key — so it only pairs start↔end within
  a stream; `recordedAt` is the durable key.
- **The run pins `(agentSessionId, harnessSessionId)` and asserts it on resume.** Pi resumes the
  *same* harnessSessionId via `--session <latestHarnessSessionId>` (`pi/adapter.ts`), so the id is
  **stable across our own restart**; a genuine change (resume failed / different agent) is abnormal →
  mark the run **`failed`** and bubble. (User-verified: Pi resume + restore work; a resumed Pi does
  **not** auto-continue an interrupted turn.)
- **Orphaned-turn detection lives in the observation layer (engine stays dumb), via two rules:**
  - *dead-pty:* a `turn_started` whose `ptyProcessId` isn't the currently-running one →
    `turn_failed{session_died}`. This unblocks the wait-and-resume case (the old turn's pty is dead
    even though the session resumed under a new pty). Extends the live `deadPtys` logic to fire at
    reconcile time.
  - *new-start-supersedes:* a `turn_started` arriving while a previous turn is still in-flight → mark
    the previous one `turn_failed`. Handles in-session interrupts (user escapes + re-prompts).
  - Both are net-new in the turn-edge derivation.
- **Agents do NOT auto-restart on runtime restart → a `paused` status + user-gated resume:**
  - The **recoverer's** whole job on boot = set every non-terminal run (`waiting`/`ready`/`running`)
    → **`paused`** in one transaction. No log reading, nothing marked ready.
  - Resume is **user-gated**: the user opens the surface (restarting its 2–3 agent sessions), then
    hits **continue**, which triggers per-run reconciliation (resolver reads the log, applies the
    watermark) → `ready` (ended/failed) or re-armed `waiting`. The continue affordance must tell the
    user to start the workflow's agent sessions first.
  - `paused` **reuses the existing pause/continue machinery** (§11) — crash-recovery and manual-pause
    are one mechanism. The gate test therefore gains a manual step: crash → restart → open surface →
    continue → finishes from snapshot.
- **The pending condition is structured & runtime-owned (NOT in opaque `state_json`).** Only
  **`wait_kind`** is an indexed column; the rest lives in a **`wait_condition` JSON** blob queried
  via SQLite `json_extract`, because `status='waiting' AND wait_kind='turn'` already narrows to a tiny
  set and the condition is a per-kind tagged union (columns-per-variant would be sparse nullables).
  Future lever: an expression index on a JSON path if volume demands. Two JSON blobs, opposite rules:
  `wait_condition` (engine introspects) vs `state_json` (opaque).
- **Trusted assumption (explicit):** every harness always emits `turn_ended`. We do **not** guard the
  silent-finish-without-death case; if a harness breaks that promise the run hangs, and the deferred
  fix is a wait-timeout. Out of scope for the gate.

**`workflow_runs` schema (locked for the gate):**

```
id              pk
workflow_key    which callback to load (hardcoded for the gate)
surface_id      surface the run is scoped to (lockdown + the continue UX)
status          paused | waiting | ready | running | done | failed     ← indexed
wait_kind       turn | user_continue | user_input | child_workflow | headless | null   ← indexed (with status)
wait_condition  JSON, per-kind; turn → { agentSessionId, harnessSessionId, afterT }   (engine introspects via json_extract)
resume_payload  JSON, "what woke you", set on → ready; e.g. { outcome: ended|failed, reason? }
state_json      OPAQUE workflow state (runtime never introspects)
state_version   int, edit-safe migration
owner           claim stamp for atomic ready→running (parallel era; harmless at concurrency 1)
ui_feedback     JSON, UI-facing { phase?, message? } via setUiFeedback (engine passes through; frontend renders)
error           JSON, set on failed (message / stack / context)
created_at / updated_at
index: (status, wait_kind)
```

**Phase-3 brainstorm refinements (2026-06-22) — the `ctx` surface (gate scope: 4 verbs):**

- **Callback = plain async TypeScript, not Effect.** `ctx` verbs are **Promise-returning**; the engine
  runs the whole callback inside `Effect.tryPromise`. Authors never see Effect. A rejected verb Promise
  = a thrown step = run `failed` (no special error path).
- **Verbs are fast; suspension is always the `return`.** No verb blocks on an agent turn; there is
  deliberately no `injectAndAwaitTurn`. `suspend(nextState, condition)` / `cont(nextState)` are
  importable helper constructors the callback returns.
- **The four gate verbs:** `spawnSession` (wraps session+pane; seed via the launch envelope, not a
  post-launch inject), `inject` (pty write), `getConversationHistory` (wraps the existing read),
  `setUiFeedback` (renamed from `setOperatingPhase` — supersedes §7).
- **`setUiFeedback({ phase?, message? })`** sets human-facing display values, stored as a `ui_feedback`
  JSON blob (extensible; engine passes it through, frontend renders). The display `phase` is **distinct
  from the reducer's internal `state.phase`** — a user-facing label vs the state-machine position.
- **Dev trigger (gate only):** two dev/API ops — *start* (insert a run row + kick the dispatcher for
  the one hardcoded callback) and *continue* (the reconcile-and-resume op for the manual resume test).
  Not the real start-a-run API (that's the SDK task).
- **Scope boundary (verified against the task files):** engine-spine owns these 4 verbs + dev trigger +
  hardcoded callback + the `turn` wait kind only. The other 5 verbs + dynamic loading/invocation/arg-
  schema/start-API are the SDK task; the controls UI + lockdown + rendering are the frontend task. The
  engine provides the `paused` status and continue *operation*; the frontend provides the button.

**Phase-4 brainstorm refinements (2026-06-22) — the proof, and the durability-test decision:**

- **Trivial test callback:** 3 phases — `spawn` (`spawnSession` + `inject`, stamp `T`, suspend on the
  turn) → `await_turn` (`getConversationHistory().at(-1)` → `setUiFeedback({phase:'done', message})`
  → `done`).
- **harnessSessionId known at spawn time (supersedes the earlier lazy-pin idea):** `spawnSession` is
  allowed to take a couple of seconds — it creates the session, waits for the PTY to come live, waits
  ~250ms, injects the seed prompt, waits ~500ms, then exponential-backoff-polls until the
  harnessSessionId is generated (it only appears after the first inject) and **returns
  `{ agentSessionId, harnessSessionId }`**. So the pin is known up front and goes straight into
  `wait_condition = { agentSessionId, harnessSessionId, afterT }`. (User-confirmed: acceptable for
  on-device software; the multi-second spawn's rare crash-window re-runs, per the v1 trade-off.)
- **Durability is BUILT; only the crash TEST is dropped.** Build the full durable-by-design machinery
  (DB-as-truth, snapshot-at-suspension, resolver/dispatcher, boot recoverer → `paused`, user-gated
  continue that reconciles against the JSONL ledger). Do **not** build the `kill -9` test harness.
  Rationale: most of the machinery is product-needed anyway (continue/reconcile = the pause/continue
  feature; orphaned-turn synthesis = normal agent-death handling), the only purely-crash piece
  (recoverer boot-sweep) is one `UPDATE`, and this brainstorm already retired most of the *design*
  risk by tracing crash paths against the real code.
- **New gate:** the test workflow runs end-to-end via the dev trigger AND the `workflow_runs` row/logs
  confirm the durable transitions happened (state snapshotted at each suspension; `waiting → ready →
  running → done`; resolver flipped on `turn_end`). Explicit `kill -9` verification is **deferred to
  dogfooding**.

**Writer rules (running list — seed for the future author guide):**

1. One return shape — `suspend(nextState, condition)`; `cont(s)` = immediately-ready sugar.
2. State holds everything that crosses a suspension — no local survives a wait.
3. `cont` is for phase boundaries only — heavy iteration goes inside a step.
4. Steps must be re-runnable — the recoverer may re-execute an in-flight step; never rely on
   "runs exactly once" in v1.
5. State must be edit-safe — additive/optional fields + a `stateVersion`; never delete a phase
   value a live run could be parked in.
6. On a failed/interrupted turn, the reducer decides — re-inject "continue", `askUser`, or give
   up. "Continue" isn't always right; the engine just delivers the failure.

## 13. Open questions (carried to per-task brainstorms)

- Is conversation text already in the JSONL `event` blobs, or does hook capture need extending
  per harness? (Gates the routing reads — resolve early.)
- Validate Pi's clean turn-boundary + message hooks (primary harness, currently weakest).
- Arg-schema language for the palette (Effect Schema?).
- Workflow code loading / hot-reload mechanics (dynamic TS import, re-import per step) — the
  gate **hardcodes** one callback; real loading deferred to the SDK task.
- ~~Default error semantics~~ **RESOLVED (engine-spine):** a thrown step is caught → run marked
  **`failed` (terminal)** with error context; not auto-retried; v1 retry = a fresh run.
  Error-phase-in-reducer deferred.
- Per-run debug trace — separate from durability, but valuable since workflows are hand-edited.
- Agent-tool return mechanism — decide after dogfooding.
- ~~Concurrency / scheduling of many simultaneous runs~~ **shape decided (engine-spine):**
  bounded worker pool consuming `ready` rows, resolver/dispatcher at concurrency 1; gate runs at
  pool size 1. Pool tuning + per-row leases deferred.
- **Writer docs deliverable (engine-spine):** workflow-author guide (→ later an agent skill)
  after the SDK task; seed now with the running rules list in §12.
- **RESOLVED (phase-2):** resume mechanics — lossy-bus boot reconciliation, start-anchored
  watermark, the `(agentSessionId, harnessSessionId)` pin, `paused` + user-gated resume, and the two
  orphaned-turn rules. See the phase-2 block in §12.
