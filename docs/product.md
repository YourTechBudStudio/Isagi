# Isagi — product overview (codename)

**Last updated:** 2026-02-07

## One-liner

Isagi (codename) is a **context continuity engine** for creative work: capture raw ideas (“sparks”), then turn them into durable artifacts via **warm-start** agent conversations where the system pre-loads everything needed so you never start from zero.

## The problem

- The work is fun once you’re in it, but **starting** is hard.
- The real tax is **activation energy**: context loading, remembering where you left off, and re-priming AI every time.
- Ideas arrive randomly (often on mobile) and get scattered across tools.
- Even when captured, they decay without a pipeline: you run dry when it’s time to post.

## Value proposition

1) **Capture once** → sparks are durable and low-friction (mobile-first capture, desktop-first deep work).
2) **Auto-triage (propose-only)** → a Triager runs on capture, asks clarifying questions, and proposes work items per workstream.
3) **Warm starts** → every task/session opens pre-loaded with the relevant spark, prior outputs, rubrics, and a “where we left off” summary.
4) **Context compounds** → outputs become artifacts that downstream agents can read.
5) **Backlog security** → the system helps you keep drafts/storylines queued so you don’t run dry.

## Core principles

- **Home is for focused work, not capture.** Capture happens via quick-add widgets.
- **Anti-overwhelm by design.** Keep “everything” accessible, but show only a small number of “next steps” by default.
- **Manual intent, warm automation.** The Triager proposes; you decide what gets created and run. Conversations resume warm.
- **Universal primitives.** Avoid per-workstream bespoke object models; use a small shared set of concepts.
- **Agents collaborate, they don’t replace you.** Background runs can pause and ask for input.
- **Co-ownership over delegation.** Agents challenge assumptions and propose alternatives; you make executive calls.

## What Isagi feels like to use (intended UX)

- **Capture** on phone instantly (text + voice).
- **Auto-triage** runs in the background and proposes next steps by workstream.
- **Deep work** happens primarily on desktop (review, editing, longer agent sessions).
- You open a proposed work item and get a **warm start**: “here’s the spark, what we know, and the next decision.”
- You run an action to start a **resumable session**. If the agent needs your input it emits a **GateRequest**.

## Primary scenarios (early)

### YouTube creation (deep)

Spark → (triage) → Video container → work items like Northstar, Research, Titles/Thumbnails, Storyline → artifacts like docs/outlines/dossiers.

### Social Marketing (lightweight)

Spark → (triage) → Social work items (e.g., “Draft LinkedIn post”, “Draft Twitter thread”) → draft artifacts in a backlog.

## MVP notes

- The MVP is a **context continuity engine** first.
- We intentionally avoid over-committing to storage/execution architecture until implementation clarifies constraints.

## Future architecture direction (post-MVP, ideation)

Primary direction: a **single persistent environment** (one always-on Linux box) that runs the app and maintains a persistent filesystem.

Optional direction (later, if needed):

- **Control plane (always-on):** stores metadata + artifacts, runs most agent/chat interactions, schedules/background processing.
- **Execution plane (sandboxed):** ephemeral environments (e.g., Sprites/Fly) for actions that need isolated tooling/filesystems (especially coding environments).
- **Local bridge (optional):** connects local repos + OpenCode context to the system.

## Non-goals (for now)

- Becoming a generic task manager / daily planner.
- Multi-user collaboration and permissions.
- Full automation that runs chains without user intent.
- BYOK/productized key management (initially use the creator’s keys).

## Not in MVP

- Product development workflows (coding sessions, repo/PR integration).

## What’s undecided

- Exact “focus” mechanics (WIP limits, scoring, timetable integration).
- How far coding sessions go (IDE choice, repo integration, PR automation).
- When/if to introduce deeper workflow graphs beyond actions + sessions.
