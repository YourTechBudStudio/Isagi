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
- `cont(nextState)` = persist + step again immediately (an internal transition, no external
  wait). `cont(s)` ≡ `suspend(s, { Now })` but kept as a distinct verb so intent is obvious.
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

## 13. Open questions (carried to per-task brainstorms)

- Is conversation text already in the JSONL `event` blobs, or does hook capture need extending
  per harness? (Gates the routing reads — resolve early.)
- Validate Pi's clean turn-boundary + message hooks (primary harness, currently weakest).
- Arg-schema language for the palette (Effect Schema?).
- Workflow code loading / hot-reload mechanics (dynamic TS import, re-import per step).
- Default error semantics (activity throws → reducer catches → error phase vs engine surfaces).
- Per-run debug trace — separate from durability, but valuable since workflows are hand-edited.
- Agent-tool return mechanism — decide after dogfooding.
- Concurrency / scheduling of many simultaneous runs (fibers).
