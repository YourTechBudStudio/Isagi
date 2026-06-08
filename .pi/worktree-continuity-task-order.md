# Worktree Continuity Task Order

Generated: 2026-06-07

## Completed

- [x] Worktree Continuity mockups — `.pi/tasks/worktree-continuity-mockups.md`
- [x] Worktree Continuity app spine — `.pi/tasks/worktree-continuity-app-spine.md`
- [x] Project and worktree navigation slice — `.pi/tasks/worktree-continuity-project-worktree-navigation.md`

## Recommended next order

1. [x] Create new worktree slice — `.pi/tasks/worktree-continuity-create-worktree.md`
   - Command palette flow for creating a Git worktree.
   - Runtime/API support for `git worktree add`.
   - Land in the new initialized worktree room.

2. [ ] First-class agent sessions slice — `.pi/tasks/worktree-continuity-agent-sessions.md`
   - Launch an agent harness in the active worktree.
   - Stream output.
   - Associate sessions with worktrees.
   - Restore last active session association on switch-back.

3. [ ] Command runner slice — `.pi/tasks/worktree-continuity-command-runner.md`
   - Define/run named project commands in the active worktree.
   - Show logs/output.
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
   - Persist/restores per-worktree surface placement.

7. [ ] Attention signals slice — `.pi/tasks/worktree-continuity-attention-signals.md`
   - Detect at least one reliable waiting-for-user path.
   - Surface attention in sidebar/worktree/agent UI.
   - Refine attention state model based on harness reality.

8. [ ] Surface split / drag / resize layout — `.pi/tasks/worktree-continuity-surface-split-layout.md`
   - Shared split-PTY layout for agent and terminal surfaces.
   - Drag panes between columns.
   - Resize gutters.
   - Persist layout per worktree.

9. [ ] Dogfood and tighten Worktree Continuity — `.pi/tasks/worktree-continuity-dogfood-tighten.md`
   - Use Isagi on real multi-project/worktree work.
   - Capture friction.
   - Decide next milestone direction.

## Notes

- `surface-split-layout` depends on both agent sessions and surfaces, so it is placed after those exist. It can move earlier if split ergonomics become painful during agent/session implementation.
- `attention-signals` depends on agent sessions, but can be explored in parallel once harness output/status exists.
- Candidate milestones remain parked until Worktree Continuity is dogfoodable:
  - `.pi/milestones/project-home-whats-next.md`
  - `.pi/milestones/context-preset-control.md`
  - `.pi/milestones/child-agent-visibility.md`
