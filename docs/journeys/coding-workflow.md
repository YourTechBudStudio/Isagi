# Coding Workflow Journey (MVP)

**Last updated:** 2026-02-28

## Journey goals

- Make execution feel resumable, not restart-heavy.
- Convert sparks into actionable task structures safely.
- Support parallel coding threads without context collisions.
- Keep close-task behavior safe and explicit.

## Actors and surfaces

- **User** - creates sparks, approves proposals, runs sessions, closes tasks.
- **Desktop app (Isagi)** - orchestration, review, command surfaces, lifecycle controls.
- **Triager session** - clarifies sparks and proposes graph changes.
- **Execution session (OpenCode-backed)** - task-focused agent work.

## Scenario A: Spark capture on desktop

1. User creates a spark from desktop capture input.
2. Spark is stored quickly with minimal friction.
3. System shows success feedback and an `Open triage now` action.
4. If user clicks `Open triage now`, a new tab opens and is focused.

## Scenario B: Triage and proposal review

1. Triager starts from spark-strengthening questions.
2. Triager consults area guidance (for example `AGENTS.md` and explicitly loaded `TRIAGE.md`; see `docs/product/config/agent-guidance-projections.md`) and current state.
3. Triager proposes one or more graph mutations (spark/project/task only).
4. Proposals appear in review state, backed by persisted proposal data.
5. User can:
   - approve/reject individual rows
   - bulk approve/reject
   - ask triager via chat to revise proposals
   - manually edit proposal fields where allowed

Only the triage review/finalize path mutates graph objects. Execution sessions do not directly create spark/project/task objects.

## Scenario C: Finalize and object creation (atomic)

1. User clicks `Finalize`.
2. System applies all approved proposals atomically.
3. Remaining proposed items are auto-rejected.
4. On success, triage tab shows created objects with `Open` actions.
5. User can continue chatting in triage or close the tab.

## Scenario D: Open task and start execution

1. User opens a created task.
2. Task tab opens immediately.
3. At start, system runs setup checks, including worktree create/attach when task policy requires it.
4. If selected command requires setup, UI shows `Preparing environment...`.
5. `started` is reached only after environment attach succeeds.
6. If command has starter prompt, it auto-sends as a user-style message.
7. Session becomes active for iterative execution.

## Scenario E: Multi-session task handling

1. User can create additional sessions on same task.
2. All sessions for that task share the task lifecycle context.
3. If task has a worktree mapping, all task sessions reuse that mapped worktree.
4. Focus queue remains task-first with session visibility.
5. Session chips behavior:
   - max 3 visible per task card
   - order: waiting-on-you, active, idle
   - overflow (`+N`) opens session picker

## Scenario F: Close task with git safety checks

1. User chooses `Close task`.
2. System checks whether another active task references the same worktree (active means started, not done, and not in error).
3. If another active task references it, this task closes without running worktree close checks.
4. Otherwise, system verifies the mapped worktree still exists.
5. If mapped worktree is missing, task enters `error` and close is not completed.
6. Otherwise, system verifies repo/worktree state.
7. If worktree is dirty or otherwise unresolved, close is blocked with clear reason/output details.
8. If resolved, close succeeds and system:
   - marks task done
   - closes associated sessions
   - deletes task worktree/branch only when no active references remain

## Command surfaces (top bar + command palette)

Commands are available through:

- top-bar contextual actions in task view
- global command palette

Examples:

- open task session
- start new task session
- create spark
- open triage
- close task

## Error and recovery paths

- **Triage apply failure:** keep triage open, show failure details, allow correction and retry.
- **Worktree failure on task start:** set task to `error` (for example missing mapped worktree or branch-baseline drift); task is not recoverable in place and must be restarted from blank after manual resolution/cleanup.
- **Worktree failure on close:** if mapped worktree is missing at close-check time, set task to `error`; user remediates manually, then uses restart-from-blank task action.
- **Close-task verification failure:** block close, show reason and output details.
- **Network unavailable:** block close checks that require remote verification.

## Invariants checklist

- Triager is propose-only.
- Finalize is atomic.
- Only triage/finalize mutates graph objects.
- Every task belongs to a project.
- Execution root resolution is deterministic.
- Worktree mapping is task-scoped and immutable after assignment.
- Task closure is safety-gated.
- Resources persist with scope-aware retrieval.
