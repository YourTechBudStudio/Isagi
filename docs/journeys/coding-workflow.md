# Coding Workflow Journey (MVP)

**Last updated:** 2026-03-17

## Journey goals

- Make execution feel resumable, not restart-heavy.
- Keep task upkeep lightweight.
- Support parallel coding threads without context collisions.
- Keep review and handoff on the same task instead of creating subtask overhead.

## Actors and surfaces

- **User** - creates tasks, starts sessions, and changes statuses.
- **Desktop app (Isagi)** - project-scoped task surfaces, optional collection grouping, command surfaces, git controls, and session visibility.
- **Execution session (OpenCode-backed)** - task-linked execution work, project-scoped scratch exploration, and project-scoped shaping work.

## Entry posture: open app and resume work

1. Home opens as a global orientation surface.
2. The most recent resumable session is the primary jump-in target.
3. Additional open sessions appear as compact secondary options.
4. Those open sessions may include task-linked, scratch, and shaping sessions; scratch and shaping sessions should be visibly marked.
5. If there are no resumable sessions, the app may show lightweight candidate tasks.
6. Global `Start a session` flows route through the command palette so project selection happens explicitly before execution begins.
7. The command palette remains the fast path for opening a specific project when the user wants deliberate project selection.

## Scenario A: Register a project

1. User runs an `Add project` command from the command palette.
2. User provides a local repo directory either by pasting a path or using a folder picker helper.
3. Isagi validates that the selected directory is an existing local git repo.
4. Isagi preloads an inferred editable project name based on the selected folder.
5. User confirms the inferred name or edits it before submitting registration.
6. The project is registered without requiring statuses, aliases, or git defaults up front.
7. Success feedback offers `Open project` and `Open settings` as follow-up actions.

Detailed registration-surface guidance lives in `docs/product/screens/project-registration-flow.md`.

## Scenario B: Create a task from command palette

1. User runs a command such as `Create task`.
2. User selects a project explicitly.
3. User enters task details such as title, optional priority, labels, and optionally a collection.
4. Task appears in the project task list with its project-defined default status.
5. If no collection is chosen, the task lives directly under the project.

## Scenario C: Shape or clean up backlog with the Project-Shaper agent

1. User opens a project and chooses **Shape what's next**, the project's entry point into the Shaper agent.
2. If the project has no prior shaping sessions, Isagi starts a new shaping session immediately.
3. If prior shaping sessions exist, Isagi first shows a small chooser so the user can resume an existing shaping session or start a new one.
4. New shaping sessions use a project-based title and begin with an empty composer.
5. The shaping session is project-scoped, tracked, and uses the Shaper agent, but it is not backed by a task.
6. The shaping companion panel stages draft task proposals only.
7. Those proposals stay staged during the session and become visible backlog items only when the shaping session is finalized and closed.
8. The shaping session appears in Home and the sidebar like any other resumable session, but it does not appear on the project board as a task.

## Scenario D: Start a task-backed ad-hoc session

1. User starts a session from project context without creating a task first.
2. Isagi creates a visible task automatically.
3. The task title is generated from the first user message and can be renamed later.
4. The session is attached to that task and opens in the project repo root.
5. The auto-created task is a normal project task and may remain ungrouped until the user later assigns it to a collection.

## Scenario E: Start a scratch session

1. User runs a `Start scratch session` command from the command palette.
2. User selects a project explicitly.
3. Isagi opens a session in that project's repo root without creating a task.
4. The session uses the same conversation shell, git controls, and execution behavior as normal sessions.
5. The scratch session stays visible in Home and the sidebar like any other session, but it is visibly marked as scratch.

## Scenario F: Choose execution mode and begin work

1. Session starts from:
   - the task's project repo root for a task-backed session
   - the selected project's repo root for a scratch session
   - the selected project's repo root for a shaping session
2. User chooses to:
   - stay on the current branch
   - create/use a managed worktree
   - decide interactively when the project/global default is `ask_each_time`
3. If a managed worktree is selected, Isagi creates it automatically.
4. Agent work begins in the chosen execution root.

## Scenario G: Continue across one or more sessions

1. User can open additional sessions on the same task.
2. Sessions are peers; none is primary by default.
3. One session may implement while another reviews or follows up.
4. Sessions can be manually closed when they are no longer relevant.

Scratch sessions can also remain open and resumable across multiple short exploration loops, but they stay outside board/task tracking.

Shaping sessions can also remain open and resumable across multiple backlog-shaping loops, while staying tracked at the project level rather than appearing as board tasks.

## Scenario H: Rebind and collision-awareness

1. During a session, the user may switch branches or move to/from a managed worktree.
2. If the execution root path changes, Isagi rebinds the same session to the new root.
3. Isagi warns when other active or idle-but-recent sessions share that directory.
4. Task and session UI can show overlapping sessions or active session counts for that directory.
5. The warning helps the user inspect overlapping sessions without hard-blocking work.

## Scenario I: Update task status

1. User changes task status manually.
2. Status labels are project-specific but map to global buckets.
3. There is no separate `Complete task` mutation in the MVP UI; task closure happens through status change.
4. Moving the task into a `done`-bucket status closes its sessions.
5. Git merge and worktree cleanup remain separate manual actions.

## Future phase note

Spark capture and spark triage are deferred to Phase 2. They are not part of the first MVP release path documented here.

## Command surfaces (top bar + command palette)

Commands are available through:

- top-bar contextual actions in project and session surfaces
- global command palette

Project Detail and the Session screen should reuse the same contextual action-bar style for common actions.

- The shared style keeps action placement and interaction posture familiar across surfaces.
- Project Detail uses that same style while swapping in project-specific actions such as shaping, task creation, collection creation, filters, and saved-view controls.
- The task-detail modal is a lighter modal exception rather than a full action-bar surface.
- Detailed session-surface guidance lives in `docs/product/screens/session-screen.md`.
- The command palette remains the global command surface when the user wants to jump context or trigger actions from anywhere.
- Scratch sessions stay primarily command-palette-driven so project selection remains explicit and they do not masquerade as backlog items.

Examples:

- create task
- start task-backed ad-hoc session
- start scratch session
- start new task session
- change task status
- switch execution root / create worktree

## Error and recovery paths

- **Ad-hoc session title is poor:** keep the auto-generated task, but allow quick rename.
- **Worktree creation failure:** keep the session in `error` and let the user retry or choose a different execution root.
- **Rebind failure:** preserve the same session identity, surface the error, and wait for manual correction.
- **Collision warning ignored:** do not block work; keep directory/session visibility available so the user can self-correct.

## Invariants checklist

- Every task belongs to a project.
- Every task may belong to zero or one collection inside that project.
- Sessions come in three kinds: task-linked, scratch, and shaping.
- Every task-linked session belongs to a task.
- Scratch sessions belong to a project and do not belong to tasks or collections.
- Shaping sessions belong to a project and do not belong to tasks or collections.
- Sessions do not belong directly to collections.
- No subtasks exist in v0; review and handoff stay on the same task.
- Tasks are execution-agnostic.
- Task status is manual and project-customizable.
- Sessions can change execution root during work.
- Collision warnings are advisory, not blocking.
