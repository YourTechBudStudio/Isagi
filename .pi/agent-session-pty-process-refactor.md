# Agent Session PTY Process Refactor Plan

## Purpose

Refactor Isagi so durable worktree-environment entities sit above disposable PTY process incarnations.

The user-facing goal is simple: an agent pane should remain part of the worktree room even when the runtime or machine restarts. Opening that pane should attach to the live process if one exists, or recreate a process and resume the latest observed harness session when possible. PTY processes are transport only.

This plan intentionally skips ADR authoring. The relevant ADRs already exist and are binding.

## Read First

Before changing code, read:

- `docs/engineering-guidance/README.md`, `principles.md`, and `how-to-use.md`: especially state ownership, explicit runtime lifecycle, diagnostics, and verification posture.
- `docs/engineering-guidance/lenses/boundaries-and-contracts.md`: runtime owns operational state; contracts must not leak implementation details as product concepts.
- `docs/engineering-guidance/lenses/state-flow-causality-and-operational-cost.md`: lazy restoration must be caused by attach/open, not hidden in broad reads.
- `docs/engineering-guidance/lenses/runtime-behavior-and-diagnostics.md`: PTY, process, restoration, harness integration, and lifecycle code are Tier 3 operational work.
- `docs/engineering-guidance/lenses/product-behavior-and-ux.md`: restored, missing, failed, or degraded state must be honest and visible.
- `docs/adrs/0005-disposable-pty-processes.md`: PTY records are process incarnations, not durable sessions.
- `docs/adrs/0006-durable-worktree-environment-entities.md`: durable worktree-environment entities own continuity; process incarnations are replaceable.
- `docs/adrs/0007-per-invocation-harness-integration.md`: harness integration must be injected per invocation and must not mutate global/user/project config.
- `.agents/skills/design-system/SKILL.md` and `docs/engineering-guidance/lenses/design-fidelity-and-voice.md` before Phase 1 or any user-facing copy/UI.

Useful code starting points:

- Contracts: `packages/contracts/src/surfaces/types.ts`, `packages/contracts/src/surfaces/api.ts`, `packages/contracts/src/runtime-events/types.ts`.
- Web terminal surface: `apps/web/src/routes/workspace/PtySurface.tsx`, `AgentSurface.tsx`, `TerminalSurface.tsx`.
- Web runtime client: `apps/web/src/lib/runtime/client.ts`, `apps/web/src/lib/workspace/runtime-data.ts`, `apps/web/src/lib/workspace/queries.ts`.
- Runtime PTY API/service: `apps/runtime/src/pty/api.ts`, `apps/runtime/src/pty/pty.service.ts`, `apps/runtime/src/pty/types.ts`, `apps/runtime/src/pty/backend.ts`.
- Runtime PTY internals: `apps/runtime/src/pty/service/*`, `apps/runtime/src/pty/adapters/node-pty.ts`, `apps/runtime/src/pty/adapters/tmux.ts`.
- Persistence: `apps/runtime/src/persistence/schema.ts`, `apps/runtime/drizzle`.
- Surfaces: `apps/runtime/src/surfaces/*`.
- Runtime composition: `apps/runtime/src/runtime.layer.ts`.
- Runtime event bus/API: `apps/runtime/src/runtime-events/*`.

## Settled Decisions From Brainstorming

Capture these as implementation constraints. Do not reopen them unless a concrete implementation blocker appears.

- Rename the durable table/domain concept from `pty_sessions` to `pty_processes`. A PTY process is a disposable incarnation, even if the backend is tmux.
- Add durable `agent_sessions` and `terminal_sessions` above PTY processes. Agent sessions are the first restoration target; terminal sessions may initially recreate fresh shells.
- Web attaches to `agentSessionId` or `terminalSessionId`, not to a PTY process ID.
- Replace the old PTY websocket route with session-level routes. Do not preserve the old route for internal compatibility unless a phase explicitly needs a temporary migration path.
- `PtyProcessService` must be generic. It should know command, args, cwd, env, owner, backend, process refs, logs, write/resize/kill, and status. It must not import or branch on harness semantics.
- Harness adapters build generic PTY launch envelopes. The PTY/process layer consumes only the generic envelope.
- Latest observed harness session ID is authoritative. Deterministic launch IDs, where supported, are only a seed/convenience. If the user starts or switches sessions inside the harness, the next hook event must replace the stored `harnessSessionId`.
- Do not parse terminal output to capture harness session IDs. Use harness-native hooks/plugins/extensions or explicit session metadata APIs.
- Harness integration uses IPC as the target path, not JSONL polling. A JSONL fallback can be added later for debugging, but should not be the main architecture.
- The IPC route should be internal to the runtime, token-gated, and not part of `packages/contracts`.
- Harness event tokens are in-memory opaque random tokens. Store no token on disk. Token lifecycle is tied strongly to the active `pty_process`: create before launch, accept events while that process is active, revoke on exit/kill/delete/startup-stale reconciliation. Do not add idle expiry.
- Inject these process env vars into harness processes and hook commands/plugins: `ISAGI_AGENT_SESSION_ID`, `ISAGI_HARNESS_EVENT_URL`, `ISAGI_HARNESS_EVENT_TOKEN`.
- Generated hook/plugin/extension/config artifacts must live under runtime-owned data paths, for example `harness-integrations/<harness>/` for static adapter artifacts and `agent-sessions/<agentSessionId>/integration/` for per-session material.
- Inherit user harness config by default. Only inject Isagi’s per-process integration on top. Do not mutate global user config, harness home config, or project-local harness config.
- A supported harness adapter must satisfy the full contract: launch, resume by session ID, per-invocation integration, and current session ID observation. Do not build a product-facing capabilities matrix for partial adapters.
- Only one active interactive websocket attachment is supported per durable session/process for now. Latest valid claim/attach wins: supersede the previous attachment with a stable `session_attachment_moved` websocket error, then close it.
- Closing a websocket is detach only. Killing a PTY process is explicit and independent from durable session deletion. Deleting a pane/surface/worktree deletes durable sessions and cleans up active processes.
- Resume should not send automatic text/input to the harness. It should only open the harness session.
- Phase 1 must be UI mock states only so the product feel can be reviewed before runtime functionality is wired.

## Target Runtime Model

Conceptual ownership:

```txt
worktree
  -> UI placement: worktree_surfaces -> surface_panes
       -> nullable pane placement: agent_session or terminal_session id
  -> durable runtime entities: agent_sessions / terminal_sessions
       -> active_pty_process_id nullable
            -> pty_processes row and live backend ref
```

Durable sessions are worktree-scoped runtime entities. They must not know which pane or surface is displaying them. `surface_panes` owns UI placement through nullable polymorphic placement fields (`session_kind`, `session_id`). Service-level validation owns preventing invalid session-kind/session-id combinations and cross-worktree placement.

Suggested persistence shape:

```txt
surface_panes
  id
  surface_id
  title
  attention
  sort_order
  session_kind nullable: agent_session | terminal_session
  session_id nullable
  created_at
  updated_at

agent_sessions
  id
  worktree_id
  harness
  cwd
  harness_session_id nullable
  harness_session_ref_json nullable
  active_pty_process_id nullable
  created_at
  updated_at
  last_seen_at

terminal_sessions
  id
  worktree_id
  cwd
  command
  active_pty_process_id nullable
  created_at
  updated_at

pty_processes
  id
  backend: node_pty | tmux
  backend_ref_json
  command
  args_json
  cwd
  status
  status_reason
  exit_code
  signal
  log_mode
  log_path
  created_at
  updated_at
  exited_at
  last_seen_at
```

Do not store full env values in the database because tokens and secrets may be present. Keep env in memory during launch and record only diagnostic-safe metadata. Do not store derived session diagnostic columns while the state can be projected from durable session facts plus active PTY process facts.

Stable diagnostic codes include:

- `harness_session_id_missing`
- `harness_resume_failed`
- `harness_launch_failed`
- `harness_event_auth_failed`
- `pty_process_launch_failed`
- `pty_process_attach_failed`
- `pty_process_missing`
- `pty_process_not_running`

## Target Contract Shape

Move pane DTOs away from `ptySession` and toward durable entities:

```ts
type SurfacePane = {
  id: number;
  surfaceId: number;
  title: string;
  attention: AttentionState;
  sortOrder: number;
  entity:
    | { kind: "agent_session"; agentSession: AgentSessionMetadata }
    | { kind: "terminal_session"; terminalSession: TerminalSessionMetadata }
    | null;
};
```

The frontend should not need `activePtyProcessId` in normal state. Expose backend/process facts only where needed for diagnostics.

Replace the websocket route:

```txt
/api/v1/pty-sessions/:ptySessionId
```

with session-level routes such as:

```txt
/api/v1/agent-sessions/:agentSessionId/attach
/api/v1/terminal-sessions/:terminalSessionId/attach
```

The exact path can vary, but it must attach by durable session ID.

Keep the websocket message protocol close to the current PTY protocol where useful: session/status, replay, output, exit, error, input, resize. Rename types to avoid implying the websocket is attaching to a durable PTY session.

## Harness Hook Findings To Preserve

These findings came from local read-only CLI/package inspection during brainstorming. Validate with controlled throwaway runs before treating any adapter as complete.

| Harness  | First capture                        | Per-turn / refresh            | Session ID source                   | Injection path                                                     |
| -------- | ------------------------------------ | ----------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| Pi       | `session_start`                      | `agent_start`, `turn_start`   | `ctx.sessionManager.getSessionId()` | `--no-extensions -e <runtime-owned-extension>`                     |
| Claude   | `SessionStart`                       | `UserPromptSubmit`, `Stop`    | hook stdin `session_id`             | `--settings <json-or-file>` with command hooks                     |
| OpenCode | plugin `event` for `session.created` | `chat.params`, `chat.message` | `sessionID`                         | `OPENCODE_CONFIG_CONTENT` plugin config                            |
| Codex    | `SessionStart`                       | `UserPromptSubmit`, `Stop`    | hook stdin `session_id`             | `--enable hooks`, `--dangerously-bypass-hook-trust`, `-c hooks...` |

Provider notes:

- Pi supports `--session <id>` for resume and `--session-id <id>` for exact open/create, but latest observed `ctx.sessionManager.getSessionId()` still owns truth.
- Claude supports `--resume <id>` and `--session-id <uuid>`, but latest observed hook `session_id` still owns truth.
- OpenCode resumes with `--session <sessionID>`. There is no dedicated agent-start hook in inspected types; use `session.created` for first capture and `chat.params` or `chat.message` for turn refresh.
- Codex resumes with `codex resume <SESSION_ID>`. Hook config via per-invocation `-c` is viable; command hooks inherit process env and can post to local runtime.

## Phase 1: Mock Agent Pane UX States

Goal: let the user review the new agent-session states before runtime functionality changes.

This phase is intentionally frontend-only. It should not implement schema, runtime, or harness behavior. Its value is product validation before a large operational refactor.

Build mockable states for an agent pane:

- normal attached/running
- connecting/attaching
- resuming/recreating process
- resume unavailable because no harness session ID was captured
- resume failed with retry affordance and diagnostic detail

Keep the work surface as the hero. Status UI should be quiet, compact, and integrated into the pane chrome or inline terminal area. Use dry, informative copy for status lines. Avoid humour in working chrome/status lines; save personality for empty or edge states only.

Implementation guidance:

- Work from `apps/web/src/routes/workspace/PtySurface.tsx`, `AgentSurface.tsx`, and `apps/web/src/copy/workspace.ts`.
- Prefer a dev-only mock path or fixture-driven component that cannot accidentally become runtime state. A query-param/dev-only mock or isolated preview component is acceptable if it is easy to remove or leave safely inert.
- Do not introduce new runtime APIs in this phase.
- If new user-facing copy is sentence-level, place it under `apps/web/src/copy/` rather than scattering prose through components.
- Preserve existing keyboard and pane focus behavior.

Verification:

- Run the relevant web/unit tests and `pnpm check` after changes.
- Manually inspect the mock states in the app or preview path. Do not start long-running dev servers from an agent; ask the user to run the appropriate command if a browser review is needed.
- Confirm text fits in pane chrome and inline states at narrow and normal widths.

Done when:

- The user can review all target states without runtime refactor work.
- Existing real PTY behavior is not broken.
- No runtime schema/API behavior changed.

## Phase 2: Replace PTY Session Surface Wiring With Durable Sessions While Preserving Current Behavior

Goal: perform the core model split while keeping launch/attach behavior roughly equivalent to today.

This phase should introduce the durable/session/process structure and replace API vocabulary, but it does not need harness session ID capture or lazy resume yet.

Work involved:

- Update persistence schema from `pty_sessions` to `pty_processes`.
- Add `agent_sessions` and `terminal_sessions`.
- Regenerate Drizzle migrations rather than hand-editing generated migration artifacts.
- Update surface/pane detail queries so panes attach to a durable entity instead of directly exposing `ptySession`.
- Update contracts in `packages/contracts/src/surfaces/types.ts` and `api.ts`:
  - add agent/terminal session metadata
  - update launch output to return `agentSessionId` or `terminalSessionId`
  - replace websocket endpoint params with session IDs
  - rename delete warnings/results from PTY session language to process/session cleanup language
- Update web runtime client helpers and `PtySurface.tsx` to resolve session-level websocket URLs.
- Split runtime service responsibilities enough that agent/terminal launch creates a durable session and an initial backing PTY process.
- Keep current backend behavior working through node-pty and tmux if tmux remains present, but tmux must be treated only as a PTY process backend.
- Update runtime events away from `pty_session_changed`. Prefer process-level events plus durable session-level events where the UI actually needs them.

Boundary guidance:

- `PtyProcessService` accepts a generic process launch envelope: command, args, cwd, env, log settings, owner identity.
- Agent/terminal services own durable session semantics.
- The PTY/process layer must not import harness adapter code.

Verification:

- Unit tests for contract schemas, runtime API launch endpoints, surface detail shape, and websocket URL construction.
- Existing launch/attach/write/resize/exit behavior still works for a newly launched agent and terminal.
- `pnpm check`.

Done when:

- A user can launch an agent session and terminal session and interact with them through the new session-level websocket routes.
- The old `pty-sessions/:id` route and public contract vocabulary are no longer used by the web.
- Durable session rows survive independently of current PTY process status.

## Phase 3: Lazy Attach Restoration, Process Lifecycle, Pane Ownership, And Diagnostics

Goal: make opening/attaching to a durable session ensure an attachable PTY process exists, while correcting pane/session ownership so panes own UI placement and durable sessions stay worktree-scoped runtime entities.

Claim/attach flow:

```txt
web creates or focuses a pane
-> pane session claim/create API validates worktree placement
-> pane placement points at an agent_session or terminal_session
-> runtime issues a single-use attach token
-> web opens agent/terminal session websocket with attachToken
-> session lifecycle consumes token and enforces latest-wins attachment
-> durable service loads session
-> if active_pty_process_id is running/starting, attach to it
-> otherwise build launch/resume intent
-> launch a new pty_process
-> update active_pty_process_id
-> attach websocket to the process
```

Agent sessions in this phase can resume only when a `harness_session_id` is already present. Harness capture arrives in later phases. Terminal sessions recreate a fresh shell when their process is missing.

Work involved:

- Correct ownership so `agent_sessions` and `terminal_sessions` are pane-unaware, worktree-scoped runtime entities, and `surface_panes` owns nullable polymorphic session placement.
- Add explicit single-pane surface creation and pane session claim/create APIs. Claim/create supports starting fresh agent/terminal sessions and claiming existing sessions, validates worktree ownership, and uses last-wins pane placement.
- Add a runtime-local `session-lifecycle` service for keyed restore locks, single-use five-minute attach tokens, active websocket registration, and active attachment supersession.
- Require websocket attach tokens. Missing, invalid, expired, or mismatched tokens are stable websocket protocol errors.
- Enforce one active interactive websocket attachment per durable session/process with latest-wins handoff. The previous socket receives `session_attachment_moved`, detaches, and closes.
- Startup reconciliation should mark stale `pty_processes` honestly, especially node-pty process records after runtime restart, while preserving durable sessions and pane placement.
- Websocket close detaches only.
- Explicit kill kills the current process and leaves the durable session unless the caller is deleting the pane/surface/worktree.
- Delete pane/surface/worktree cleans up pane-owned session placement, durable sessions, and active process incarnations through the normal cleanup paths.
- Keep diagnostic state derived read-side from durable session facts plus active PTY process facts. Do not add durable diagnostic columns while the state is derivable.
- Add frontend handling for the protocol-only moved attachment state with `Start fresh` and `Claim session` actions.
- Add simple runtime orphan session GC: sessions with no pane placement are eligible after a 60 second grace period; active websocket attachments are skipped; live active PTY processes are killed/cleaned before durable session deletion.

Verification:

- Tests for pane-owned placement, surface detail projection, and cross-worktree claim rejection.
- Tests for explicit surface creation and pane session claim/create behavior.
- Tests for attach token issuance, single-use consumption, expiration, revocation, and attach-token websocket errors.
- Tests for latest-wins websocket supersession and `session_attachment_moved` handling.
- Tests for startup reconciliation: stale processes become terminal, durable sessions/pane placement remain.
- Tests for lazy attach reusing a live process.
- Tests for lazy attach creating a new process when active process is missing.
- Tests for concurrent attach/restore producing exactly one process.
- Tests for failed restoration leaving the pane/entity visible with stable derived diagnostics.
- Tests for moved-attachment frontend state/actions and orphan session GC.
- `pnpm check`.

Done when:

- Runtime restart no longer makes durable agent/terminal panes disappear or become conceptually dead.
- Opening a pane performs claim-then-attach and lazy process recreation when appropriate.
- The UI can render honest failed/unavailable/moved states from runtime facts and websocket protocol errors.
- Pane/session ownership is modeled in the right direction: panes own placement, sessions own runtime continuity, and PTY processes remain disposable transports.
- Orphan sessions are cleaned up without adding a public session deletion API.

## Phase 4: Internal Harness Event IPC And Pi Adapter End To End

Goal: implement the harness event path and prove the full restoration loop with one adapter before multiplying provider work.

Choose Pi first because local inspection found strong extension support and a clear session manager API.

Work involved:

- Add an internal runtime-only harness event route, for example `POST /internal/harness-events`.
  - It should not be part of `packages/contracts`.
  - It must validate bearer token and decode a small stable event payload.
  - It should map token to `agentSessionId`, `ptyProcessId`, and harness in memory.
- Add an in-memory harness event token registry.
  - Create token before spawning an agent process.
  - Inject token and event URL through env.
  - Revoke on process exit, kill, delete, or stale-process reconciliation.
  - Store no tokens on disk.
- Add `HarnessAdapterRegistry` and a Pi adapter.
- Generate/runtime-own the Pi extension artifact.
- Pi launch envelope:
  - inject `ISAGI_AGENT_SESSION_ID`
  - inject `ISAGI_HARNESS_EVENT_URL`
  - inject `ISAGI_HARNESS_EVENT_TOKEN`
  - include `--no-extensions -e <isagi-extension>`
  - use `--session <latestObservedHarnessSessionId>` for resume when available
  - do not rely on `--session-id` as truth; hook observation still owns identity
- Pi extension should post session observations on `session_start` and refresh on `agent_start` and/or `turn_start`.
- Runtime updates `agent_sessions.harness_session_id` to the latest observed Pi session ID.

Verification:

- Unit tests for token registry lifecycle.
- API tests for valid/invalid harness event tokens.
- Adapter tests for generated Pi launch/resume envelope.
- Service tests that a harness event updates only the matching agent session and process.
- Controlled manual spike for Pi with a runtime-owned extension writing to the internal route. Use throwaway sessions/data and do not mutate global/project config.
- `pnpm check`.

Done when:

- A Pi agent session can launch, report its current harness session ID through the internal route, persist that ID, and later lazy attach can resume using the latest observed ID.
- If the user switches/starts a new Pi session inside the harness, a later hook event replaces the stored harness session ID.

## Phase 5: Add OpenCode, Claude, And Codex Adapters

Goal: bring the remaining supported harnesses to parity with the strict adapter contract.

Adapters must each support:

- launch new session
- resume using latest observed `harness_session_id`
- per-invocation hook/plugin/config injection
- hook/plugin event delivery to runtime IPC
- updating the durable agent session from latest observed session ID

OpenCode:

- Inject plugin through `OPENCODE_CONFIG_CONTENT`.
- Use `event` for `session.created` and `chat.params` or `chat.message` for refresh.
- Resume with `opencode --session <sessionID> <project>`.
- Be careful with `OPENCODE_PURE`: it disables external plugins, so do not use it for Isagi plugin injection.

Claude:

- Inject hooks through `--settings <json-or-runtime-owned-file>`.
- Use `SessionStart`, `UserPromptSubmit`, and `Stop`.
- Hook stdin includes `session_id`.
- Resume with `claude --resume <id>`.
- Prefer command hooks initially; native HTTP hooks can be investigated later if useful.

Codex:

- Inject command hooks with per-invocation `-c` config.
- Use `SessionStart`, `UserPromptSubmit`, and `Stop`.
- Use `--enable hooks` and `--dangerously-bypass-hook-trust` for runtime-owned process-scoped hooks.
- Resume with `codex resume <SESSION_ID>`.

Verification:

- Adapter envelope tests for each harness.
- Hook payload decoder tests for each harness.
- Harness event update tests for each provider.
- Controlled manual validation for each provider with throwaway sessions and runtime-owned artifacts.
- `pnpm check`.

Done when:

- All four supported harnesses satisfy the same strict restoration contract.
- No supported harness relies on global/user/project config mutation.
- Latest observed session ID wins for all four providers.

## Phase 6: Cleanup, Naming, And Review Hardening

Goal: remove old vocabulary and make the new model easy to maintain.

Work involved:

- Rename remaining code identifiers, logs, tests, and copy from `ptySession` to `ptyProcess` where they refer to process incarnations.
- Keep `agentSession` and `terminalSession` names for durable entities.
- Update `apps/runtime/AGENTS.md` to clarify tmux is a legacy/optional PTY process backend only, not a restoration mechanism.
- Ensure `packages/contracts/src/index.ts` exports the new types and stops exporting obsolete PTY-session contract types.
- Update runtime event names and web event handling to match durable session/process vocabulary.
- Revisit delete/worktree cleanup copy so user-facing messages say “process” only when diagnostic detail is intended; avoid making process internals prominent in normal UI.
- Remove temporary mocks or ensure Phase 1 mock affordances are dev-only and inert in production.

Verification:

- `rg "ptySession|pty_session|PTY session|pty-sessions"` should return only intentional compatibility notes, migration history, or backend diagnostic internals.
- Full `pnpm check`.
- Run focused runtime/web tests touched by the refactor.
- Final engineering-guidance review is appropriate for this refactor once implementation exists.

Done when:

- The codebase vocabulary matches the product model.
- A fresh agent can understand the split by reading ADRs and service names.
- There is no public route or contract encouraging clients to treat PTY processes as durable sessions.

## Cross-Phase Test Strategy

Let test coverage scale with risk. At minimum, this refactor needs:

- Contract schema tests for new surface/session/process DTOs and websocket messages.
- Runtime repository/service tests for durable session creation, active process pointer updates, deletion cleanup, and startup reconciliation.
- Websocket tests for attach, reject-second-attach, write, resize, replay, exit, and error behavior.
- Lazy restore tests for live process reuse, missing process recreation, missing harness session ID, and resume failure.
- Harness event route tests for token validation, wrong harness/process/session mapping, invalid payloads, and revoked tokens.
- Adapter tests for launch/resume envelopes and generated artifact paths.
- Web tests for rendering normal, connecting, resuming, unavailable, and failed states.

Always run `pnpm check` after code changes, per repository guidance.

## Risks To Watch

- Race conditions during lazy attach. Guard per durable session, not globally.
- Accidentally storing env/secrets in `pty_processes`.
- Leaking harness backend details into user-facing contracts.
- Letting frontend state become authoritative for operational runtime facts.
- Treating deterministic launch IDs as truth after the user switches sessions inside the harness.
- Breaking user harness config by over-isolating. Inherit user config by default; inject only Isagi runtime-owned integration.
- Synchronous hook commands blocking harness UX. Keep hook payloads small and timeouts short.
- Codex `--dangerously-bypass-hook-trust` needs clear internal justification in code comments because the flag name is alarming. The reason is process-scoped trust of Isagi-owned hook commands without persistent config mutation.
