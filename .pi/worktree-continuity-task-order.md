# Worktree Continuity — Base build order

Updated: 2026-06-21

The base is **complete and dogfoodable** (`milestone: worktree-continuity-base`). The
remaining surface work and code review were split into follow-on milestones on 2026-06-21
(see "Split into", below).

## Completed (base v1)

- [x] Mockups — `worktree-continuity-mockups`
- [x] App spine — `worktree-continuity-app-spine`
- [x] Project and worktree navigation — `worktree-continuity-project-worktree-navigation`
- [x] Create new worktree — `worktree-continuity-create-worktree`
- [x] First-class agent sessions / PTY baseline — `worktree-continuity-agent-sessions`
- [x] PTY session close/delete lifecycle — `worktree-continuity-pty-session-close-delete`
- [x] Attention signals — `worktree-continuity-attention-signals`
- [x] Command runner — `worktree-continuity-command-runner`
- [x] Surface split / drag / resize layout — `worktree-continuity-surface-split-layout`

## Split into (deferred)

- `worktree-continuity` (paused) — remaining worktree surfaces:
  - [ ] Browser and artifact surfaces — `worktree-continuity-surfaces`
  - [ ] Secondary work surface — `worktree-continuity-secondary-surface` (depends on surfaces)

## Notes

- `pty-session-close-delete` is intentionally separate from split-layout collapse: collapse
  preserves panes/sessions; delete removes them and cleans logs. (Collapse was ultimately
  descoped from the split-layout slice; the schema stays collapse-ready for later.)
- Completing the base unparks the previously-gated candidate milestones:
  `project-home-whats-next`, `context-preset-control`, `child-agent-visibility`.
