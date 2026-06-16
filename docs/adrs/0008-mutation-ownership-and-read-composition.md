# 0008-mutation-ownership-and-read-composition

status: accepted
date: 2026-06-15

## Decision

Runtime services own mutations for the source facts in their domain. A service must not directly mutate another service's source-of-truth tables as a convenience.

Service boundaries are mutation boundaries, not read boundaries. Read-side code may join across service-owned tables to build API DTOs, workspace snapshots, surface detail, diagnostics, public events, or other projections. Reads do not imply ownership.

Persist source facts rather than derived product state where practical. User-facing status, status reasons, diagnostic codes, availability, and recovery affordances may be derived at read time from multiple source-fact tables.

When a durable entity points at a replaceable operational resource, the durable entity owns that pointer. The resource row should not know the product concept consuming it unless the resource domain itself needs that fact.

Cross-domain state changes should happen through explicit service APIs or domain events, not by one service silently writing another service's tables.

## Motivation

Isagi's runtime state spans durable worktree-environment entities, disposable operational resources, Git/filesystem facts, persistence, and recovery behavior. These facts often need to be read together, but they should not all be mutable from everywhere.

Strict mutation ownership keeps service boundaries explainable and failures diagnosable. Read composition keeps the runtime practical: SQLite can join source facts into the projections the product needs without duplicating derived state into every table.

## Consequences

- Write paths must make the owned domain/table obvious.
- Read-model code may join across domains, but should remain read-only and projection-oriented.
- Derived product state should be centralized where practical instead of scattered across handlers and UI adapters.
- Durable entities may point at replaceable resources without requiring those resources to point back.
- Public runtime events should expose client-facing projections, not arbitrary internal facts.

## Current Application

For the Phase 2 agent-session PTY process refactor:

- `agent_sessions`, `terminal_sessions`, and `pty_processes` each have separate mutation owners.
- PTY process rows stay generic and owner-unaware.
- Agent and terminal session rows own their `active_pty_process_id` pointer.
- Session status/reason/diagnostics are derived from durable session facts plus active PTY process facts.
- Surface-detail reads may join panes, sessions, and PTY processes to build the API DTO.
