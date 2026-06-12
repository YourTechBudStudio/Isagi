---
title: Dogfood and tighten Worktree Continuity
status: todo
milestone: worktree-continuity
created: 2026-05-29
updated: 2026-06-12
depends_on: [worktree-continuity-create-worktree, worktree-continuity-agent-sessions, worktree-continuity-command-runner, worktree-continuity-surfaces, worktree-continuity-code-review-surface, worktree-continuity-secondary-surface, worktree-continuity-attention-signals]
---

# Outcome

Validate Worktree Continuity on real work and tighten the next direction from actual friction.

# Context

The milestone is proven only when Isagi can be used on Isagi or another real project across multiple projects/worktrees with agents, commands, surfaces, secondary window, and attention signals.

This task should turn dogfooding feedback into concrete follow-up decisions: polish current milestone, split remaining work, or move toward a candidate milestone.

# Done condition

Done when Isagi has been used for a real multi-project/worktree workflow, the core continuity loop has been evaluated, major friction has been captured, and the next milestone/task direction has been decided.

# Notes

Use this task to decide whether the next valuable direction is more Worktree Continuity polish, Child Agent Visibility, Context and Preset Control, or something newly discovered.

Specific PTY-session dogfood checks to include:

- Validate Pi, OpenCode, Claude, and Codex as real TUIs, not just fake-adapter tests.
- Check OpenCode rendering fidelity with xterm WebGL enabled and fallback behavior when WebGL is unavailable.
- Exercise frontend refresh and worktree/surface switching while sessions continue running in the runtime.
- Try long-running sessions with large scrollback and note whether full log replay is still acceptable.
- Capture friction around dead/failed sessions staying visible without a close/delete action.
- Revisit whether tmux/runtime-supervisor restart survival is worth a dedicated POC after real usage.
