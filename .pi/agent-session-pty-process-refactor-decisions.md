# Agent Session PTY Process Refactor Decisions

Companion decision log for `.pi/agent-session-pty-process-refactor.md`. This captures implementation decisions that future phases should preserve unless a concrete blocker appears.

## Phase 2: Durable sessions above PTY processes

### Decisions made

- Phase 2 is allowed to break database compatibility, API contracts, and intermediate frontend behavior. Correct architecture is more important than preserving the old `pty_sessions` path.
- Drizzle migrations were regenerated fresh from the new schema. The missing `apps/runtime/drizzle/` directory before this refactor was intentional.
- Durable worktree-environment sessions live above disposable PTY processes:
  - `agent_sessions`
  - `terminal_sessions`
  - `pty_processes`
- `pty_processes` rows are generic operational resource records. They must not store agent-session or terminal-session owner fields.
- Durable session rows own the sticky `active_pty_process_id` pointer. Once set, it is not cleared merely because the process exits, fails, or is killed. It is replaced only when a legitimate replacement process is created.
- A durable session must not create a replacement PTY process while its current `active_pty_process_id` points to a `starting` or `running` process.
- Database tables should store source facts, not derived product status. Session status, status reason, diagnostics, and recovery affordances are read-time projections from durable session facts plus active PTY process facts.
- Mutation ownership is strict: each service mutates only its source-fact table(s). Read-side composition may join across tables. This follows ADR 0008.
- Cross-domain updates should happen through explicit service APIs or internal domain events, not by one service mutating another service's table as a convenience.
- Internal PTY process lifecycle events are owner-unaware and published to the internal runtime event bus.
- Public runtime events are a projection over internal events. The frontend receives only durable session events such as `agent_session_changed` and `terminal_session_changed`.
- Internal `agent_session_changed` and `terminal_session_changed` events are used to project durable-session changes that are not caused by a PTY process lifecycle transition, such as replacing `active_pty_process_id`.
- The web/runtime contract must not expose PTY process IDs, backend refs, log paths, or backend details as normal product state.
- Surface panes expose a durable session via `pane.session`, not a PTY process/session record.
- The websocket routes attach by durable session ID. The websocket protocol can keep PTY-oriented message names because it transports PTY bytes.
- Opening a session-level PTY websocket is the explicit trigger for lazy process restoration. Ordinary surface/workspace reads must remain projection-only and must not recreate processes.
- Agent and terminal session services own per-session restore locks so concurrent attaches cannot create multiple replacement PTY processes for the same durable session.
- A `starting` or `running` active PTY process is treated as non-replaceable. Attach/recovery reuses it rather than launching another process.
- Terminal sessions recreate a fresh shell process when the active process is missing, exited, failed, or killed.
- Agent sessions only launch a resume process when `harness_session_id` exists. If no harness session id has been captured, attach fails honestly and the read projection surfaces `harness_session_id_missing`.
- PTY websocket attachments are exclusive per active PTY process. A second interactive websocket receives `session_already_attached` instead of replacing the first attachment.
- Frontend recovery/restore states are derived from session metadata (`status`, `statusReason`, `diagnosticCode`) rather than a separate `restoreState` contract field.
- Harness event IPC is runtime-internal and intentionally not part of `packages/contracts`.
- Harness event tokens are in-memory only. They are generated immediately before spawning the harness process, injected through env, and revoked when the matching PTY process exits, fails, or is killed.
- The token registry maps a token to `agentSessionId`, `ptyProcessId`, and harness. Incoming harness events must match that token-owned target before mutating durable session state.
- Harness adapters own provider-specific launch/resume flags and integration injection. `PtyProcessService` still receives only a generic command/args/cwd/env launch envelope.
- Runtime-owned harness integration artifacts live under runtime-owned data paths and are injected per invocation, not through global/user/project config mutation.
- Pi session observations use `session_start`, `agent_start`, and `turn_start`, and latest observed `ctx.sessionManager.getSessionId()` wins over deterministic or requested IDs.

## Phase 3: Lazy restoration and pane/session ownership correction

### Decisions made

- Phase 3 is allowed to re-evaluate and rewrite Phase 2 scaffolding from first principles. Existing partial Phase 3 implementation is not binding; tests and the model decisions below own the behavior.
- Diagnostic state remains derived read-side wherever possible. Do not add durable `diagnostic_code` or `diagnostic_detail` columns to agent or terminal sessions unless a future fact is genuinely non-derivable.
- Session/activity logs are deferred. A future diagnostic/support phase may add an append-only action log, but that log must remain evidence/history and must not become the source of current session status.
- `agent_sessions` and `terminal_sessions` are worktree-scoped runtime entities. They must not own or depend on panes or surfaces.
- `surface_panes` owns UI placement. A pane points at its current durable session through nullable polymorphic placement fields (`session_kind`, `session_id`).
- The worktree owns both branches of the model: UI placement (`worktree_surfaces` -> `surface_panes`) and runtime entities (`agent_sessions` / `terminal_sessions` -> active PTY process). Lower-level runtime entities do not know which UI pane is displaying them.
- Losing database-level foreign keys for polymorphic pane placement is acceptable. Service-level validation owns preventing cross-worktree placement and invalid session-kind/session-id combinations.
- Agent and terminal sessions should not be deleted by arbitrary session APIs. Normal deletion happens through pane/surface/worktree cleanup; orphan cleanup is handled by a simple runtime-local GC.
- Pane/session ownership and websocket attachment are separate operations. Claim/create APIs decide which pane owns a session; websocket attach only attaches to an already-authorized session transport.
- Attach authorization will use in-memory, opaque, single-use attach tokens with a five-minute TTL. Tokens are passed to browser websocket attach as a query parameter because browser WebSocket APIs cannot send custom headers.
- Claiming or creating a pane session issues a fresh attach token, revokes prior tokens for that session, and supersedes any active websocket attachment for that session.
- Active websocket supersession is runtime-local lifecycle coordination owned by a `session-lifecycle` service, not durable session state. The old socket receives `session_attachment_moved` and then closes.
- The `session_attachment_moved` state is protocol-only. It is not stored on durable sessions and is not emitted as durable session metadata/events.
- The first implementation of explicit surface creation should support single-pane surface creation only, while keeping the contract shape open to composite surface+pane creation.
- Creating a new surface/pane should update focus to the created pane.
- Starting fresh in a pane leaves the old session alive if another pane owns it, or leaves it for orphan GC if no pane owns it.
- Orphan session GC should be simple: sessions with no pane placement are cleaned after a 60 second grace period; live active processes are killed/cleaned as part of that cleanup.

### Implemented in Phase 3A

- Corrected the persistence ownership direction: pane placement now lives on `surface_panes.session_kind` / `surface_panes.session_id`; `agent_sessions` and `terminal_sessions` no longer have `pane_id` columns.
- Regenerated Drizzle migration artifacts for the schema change.
- Updated surface read projections and delete cleanup composition to join pane placement to durable sessions at read time.
- Kept existing launch behavior working by assigning the newly created session to the newly created pane after session creation.
- Updated runtime event projection to resolve current pane placement from the surface repository before publishing public session events.
- Added coverage that surface detail composes pane-owned agent session placement.

### Implemented in Phase 3B

- Added explicit single-pane surface creation as a worktree/surface API: create the UI surface and pane first, focus the created pane, and keep session creation separate.
- Added pane session claim/create contract and runtime API. The pane claim operation supports `start_fresh_agent`, `start_fresh_terminal`, `claim_agent_session`, and `claim_terminal_session`.
- `start_fresh_*` creates a worktree-scoped durable session through the relevant session service, launches its initial PTY process, and assigns the new session to the pane through pane-owned placement.
- `claim_*_session` validates the durable session exists and belongs to the same worktree as the pane before moving pane placement.
- Pane session claiming is last-wins at the placement layer: assigning a session to a pane clears that same session from any previous pane before setting the new pane pointer.
- Claim/create updates worktree environment focus to the claimed pane.
- Removed the public old launch endpoint shape from contracts/runtime route registration. The web launch helpers now compose `createSurface` followed by `claimPaneSession` so existing palette actions keep working while the frontend is migrated to first-class pane session claims.
- Phase 3B intentionally did not issue attach tokens yet; token issuance and websocket authorization were reserved for Phase 3C's `session-lifecycle` slice.

### Implemented in Phase 3C

- Added a runtime-local `session-lifecycle` service that owns keyed durable-session restore locks, single-use attach tokens, active websocket attachment registration, and active attachment supersession.
- Moved agent and terminal lazy-restore locking out of duplicated Promise queues and into `SessionLifecycle.withRestoreLock`, keyed by durable session identity (`agent_session` / `terminal_session` plus session id).
- Pane session claim/create now issues a fresh opaque attach token, revokes any previous token for that durable session, and supersedes any active websocket attachment for that session.
- Attach tokens are in-memory only, single-use, scoped to one durable session, and expire after five minutes. Browser websocket attach passes the token as the `attachToken` query parameter.
- Websocket attach now consumes the attach token before resolving/restoring the backing PTY process. Missing, invalid, expired, or mismatched tokens are stable websocket protocol errors.
- Active websocket supersession is latest-wins at the runtime lifecycle layer. The previous active websocket receives `session_attachment_moved`, detaches from the PTY process, and closes.
- `session_attachment_moved` remains protocol-only attachment state. It is not persisted and is not projected as durable session metadata.
- The PTY process attachment guard remains in place as a defensive lower-level invariant even though session-level lifecycle supersession is now the preferred handoff path.

### Implemented in Phase 3D

- Bound the web terminal surface to the tokenized claim-then-attach flow. A pane claims its current durable session before opening the websocket, receives a fresh single-use attach token, and attaches with that token in the websocket URL.
- Added frontend handling for the protocol-only `session_attachment_moved` condition. The pane stops rendering the old xterm attachment, shows a quiet moved state, and offers `Start fresh` as the primary action and `Claim session` as the secondary action.
- `Start fresh` keeps the existing surface and pane, creates a new durable agent or terminal session for that pane through the pane session claim API, and uses the previous agent harness when starting a fresh agent session.
- `Claim session` reclaims the moved durable session for the same pane through the pane session claim API, which issues a new attach token and triggers the latest-wins websocket lifecycle.
- Added simple runtime orphan session GC. Agent and terminal sessions with no pane placement are eligible after a 60 second grace period; the GC skips sessions with active websocket attachments, kills any still-running active PTY process, revokes/supersedes lifecycle state, and deletes the orphan durable session row.
- The orphan GC is runtime-local cleanup and does not introduce a public session deletion API. Pane/surface/worktree cleanup remains the normal user-driven deletion path.

### Things left

- Finish provider parity beyond Pi: OpenCode, Claude, and Codex adapters still need the same strict launch/resume/per-invocation integration/session-observation contract.
- Move any remaining temporary provider-specific resume envelope logic out of session services and into harness adapters.
- Complete Phase 6 vocabulary cleanup. Some internal `ptySessionId` names may remain inside backend/ref implementation details under `pty-processes`; these should be renamed where safe without obscuring backend semantics.
- Keep public contracts and web code free of PTY process identity/details. Future diagnostic surfaces may expose process facts only deliberately and as diagnostics, not as product continuity state.
- Preserve the invariant that ordinary reads are projection-only. Future restoration behavior must continue to be triggered by explicit attach/open flows, not workspace or surface reads.
- Add or extend focused tests for harness event IPC, token lifecycle, adapter launch envelopes, lazy restore failure states, and event projection as the remaining adapters land.
- Root `pnpm check` passed after Phase 3D changes.
