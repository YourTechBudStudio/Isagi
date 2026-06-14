# Worktree Continuity Task Order

Updated: 2026-06-12

## Completed

- [x] Worktree Continuity mockups — `.pi/tasks/worktree-continuity-mockups.md`
- [x] Worktree Continuity app spine — `.pi/tasks/worktree-continuity-app-spine.md`
- [x] Project and worktree navigation slice — `.pi/tasks/worktree-continuity-project-worktree-navigation.md`
- [x] Create new worktree slice — `.pi/tasks/worktree-continuity-create-worktree.md`
- [x] First-class agent sessions / PTY baseline — `.pi/tasks/worktree-continuity-agent-sessions.md`
  - Runtime-owned PTY sessions with node-pty adapter.
  - Agent and terminal launch from the worktree-scoped palette.
  - xterm rendering, log replay, persisted surfaces/panes/sessions/focus.

## Recommended next order

1. [x] PTY session close/delete lifecycle — `.pi/tasks/worktree-continuity-pty-session-close-delete.md`
   - Add explicit stop/kill/close/delete actions for PTY-backed panes/surfaces.
   - Remove DB rows and `.ptylog` files only on user-caused deletion.
   - Keep failed/exited evidence visible until the user cleans it up.

2. [ ] Attention signals slice — `.pi/tasks/worktree-continuity-attention-signals.md`
   - First tighten rail honesty: aggregate PTY lifecycle state to worktree rows and show surface-row attention dots.
   - Refresh/patch rail metadata when visible PTY sessions exit or fail.
   - Then explore reliable waiting-for-user detection per harness.

3. [ ] Command runner slice — `.pi/tasks/worktree-continuity-command-runner.md`
   - Define/run named project commands in the active worktree.
   - Show logs/output in the commands drawer/status strip.
   - Prototype persistent vs non-persistent lifecycle.

4. [ ] Browser and artifact surfaces slice — `.pi/tasks/worktree-continuity-surfaces.md`
   - Open browser/file/Markdown surfaces.
   - Associate surfaces with active worktree.
   - Restore surfaces on return.
   - Show missing artifact state.

5. [ ] Code review surface slice — `.pi/tasks/worktree-continuity-code-review-surface.md`
   - Provide a usable code review path for the active worktree.
   - Likely via code-server/editor surface or pragmatic browser-backed surface.

6. [ ] Secondary work surface slice — `.pi/tasks/worktree-continuity-secondary-surface.md`
   - Add practical secondary window/work surface support.
   - Persist/restore per-surface placement, including agent and terminal surfaces.

7. [ ] Surface split / drag / resize layout — `.pi/tasks/worktree-continuity-surface-split-layout.md`
   - Shared split-PTY layout for agent and terminal surfaces.
   - Split panes horizontally/vertically, resize gutters, collapse panes.
   - Persist layout tree, gutter weights, collapsed state, and active pane focus.

8. [ ] Dogfood and tighten Worktree Continuity — `.pi/tasks/worktree-continuity-dogfood-tighten.md`
   - Use Isagi on real multi-project/worktree work.
   - Validate real Pi/OpenCode/Claude/Codex TUI behavior and long replay.
   - Capture friction and decide next milestone direction.

## Notes

- `attention-signals` can now move earlier because the PTY baseline exists. The first attention pass should separate lifecycle honesty from harder waiting-for-user detection.
- `surface-split-layout` can move earlier if orchestrator/child-agent workflows become the next pressure point. The runtime already persists one-leaf layout JSON, so this task extends the existing model.
- `pty-session-close-delete` is intentionally separate from split-layout collapse: collapse preserves panes/sessions; delete removes them and cleans logs.
- Candidate milestones remain parked until Worktree Continuity is dogfoodable:
  - `.pi/milestones/project-home-whats-next.md`
  - `.pi/milestones/context-preset-control.md`
  - `.pi/milestones/child-agent-visibility.md`
