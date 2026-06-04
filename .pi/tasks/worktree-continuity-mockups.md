---
title: Worktree Continuity mockups
status: completed
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-06-03
depends_on: []
---

# Outcome

Validate the Worktree Continuity experience before building functional slices.

# Context

Isagi's first milestone is about making each project checkout/worktree feel like a resumable environment. Before implementation, create concrete mockups to test whether the mental model works visually and interaction-wise.

Mockups should cover:

- project/worktree sidebar
- main agent surface
- side panel for browser/artifact/code surfaces
- secondary work surface for two-monitor workflows
- command palette flows such as new worktree, run command, open surface
- attention badges/signals

# Done condition

Done when 2-3 meaningfully different layout/interaction variants have been explored, tradeoffs are clear, and one direction is chosen for the first implementation slice.

# Notes

Follow Isagi's design system: deep canvas, restrained Catppuccin accents, agent/work surface as the hero, calm status language, and keyboard-first power use.

# Outcome (done)

The experience was validated **and** the full presentational shell was built in
`apps/web` on mock data (Phases 1–7). Durable decisions are captured in the
slice task notes plus the staged shell implementation (`apps/web/src/routes/workspace/*`,
`apps/web/src/lib/workspace/*`, and `apps/web/src/lib/palette/*`).

Chosen direction: **nested rail** navigation (no top tabs), a **chrome-free
tabbed-less canvas** of surfaces, a **floating action bar**, a **morphing
command palette**, and **zen mode**. Built component areas:

- Design tokens (Tailwind `@theme`), fonts, atmosphere; frameless rail-spine shell.
- Rail (nested sessions → surfaces, accent-spine hierarchy, attention dots, tooltips).
- Canvas (agent + terminal split-PTY surfaces, surface placeholders, empty states).
- Status strip + commands drawer; floating action bar (shared session-action source).
- **Command palette**: a config-driven, append-only **Global registry** + internal
  groups (this-session actions / surfaces / switch-session), per-group recents,
  a generic select/combo/text **wizard runner**, context snapshot from the store.
  The **action bar is a curated subset of the same source** (palette = source of
  truth); action-bar customization is deferred to a later milestone.
- Zen mode (canvas `layoutId` expand/collapse; asks the host shell to quiet native chrome).

State on Zustand; one expo-out motion vocabulary; `prefers-reduced-motion` respected.

Remaining shell-level follow-up: the **surface split-drag-resize** slice (its own
task) and parked niceties (attention toast, action-bar customization,
port→surface binding). Everything here is mock; the functional runtime slices follow.

# Verification checklist for the staged mock shell

Static verification: `pnpm check` from the repo root.
Manual smoke pass (because this slice intentionally has no runtime/test harness yet):

- `Mod+K` opens/closes the palette; empty-query recents remain grouped.
- `Mod+N` starts the new-session wizard; default project/worktree/harness values prefill correctly.
- Palette actions add/select session surfaces and toggle command run/stop labels.
- Failed commands remain visible in the status strip as command attention, not as “running”.
- Drawer command rows are keyboard-reachable: run/stop and select-log actions are separate controls.
- Zen mode enters/exits with `Mod+.`/`Esc` and keeps the palette usable.
