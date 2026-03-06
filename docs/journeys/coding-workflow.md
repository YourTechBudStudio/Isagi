# Coding Workflow Journey (MVP)

**Last updated:** 2026-03-06

## Journey goals

- Make execution feel resumable, not restart-heavy.
- Keep task upkeep lightweight.
- Support parallel coding threads without context collisions.
- Keep review and handoff on the same task instead of creating subtask overhead.

## Actors and surfaces

- **User** - creates tasks, starts sessions, and changes statuses.
- **Desktop app (Isagi)** - task list, command surfaces, git controls, session visibility.
- **Execution session (OpenCode-backed)** - task-linked agent work.

## Entry posture: open app and resume work

1. Home opens as a global orientation surface.
2. The most recent resumable session is the primary jump-in target.
3. Additional open sessions appear as compact secondary options.
4. If there are no resumable sessions, the app may show lightweight candidate tasks.
5. The command palette remains the fast path for opening a specific project when the user wants deliberate project selection.

## Scenario A: Create a task from command palette

1. User runs a command such as `Create task`.
2. User selects a project or uses the currently active project context.
3. User enters task details such as title, optional priority, and labels.
4. Task appears in the project task list with its project-defined default status.

## Scenario B: Start an ad-hoc session

1. User starts a session from project context without creating a task first.
2. Isagi creates a visible task automatically.
3. The task title is generated from the first user message and can be renamed later.
4. The session is attached to that task and opens in the project repo root.

## Scenario C: Choose execution mode and begin work

1. Session starts from the task's project repo root.
2. User chooses to:
   - stay on the current branch
   - create/use a managed worktree
   - decide interactively when the project/global default is `ask_each_time`
3. If a managed worktree is selected, Isagi creates it automatically.
4. Agent work begins in the chosen execution root.

## Scenario D: Continue across one or more sessions

1. User can open additional sessions on the same task.
2. Sessions are peers; none is primary by default.
3. One session may implement while another reviews or follows up.
4. Sessions can be manually closed when they are no longer relevant.

## Scenario E: Rebind and collision-awareness

1. During a session, the user may switch branches or move to/from a managed worktree.
2. If the execution root path changes, Isagi rebinds the same session to the new root.
3. Isagi warns when other active or idle-but-recent sessions share that directory.
4. Task and session UI can show overlapping sessions or active session counts for that directory.
5. The warning helps the user inspect overlapping sessions without hard-blocking work.

## Scenario F: Update task status

1. User changes task status manually.
2. Status labels are project-specific but map to global buckets.
3. Moving the task into a `done`-bucket status closes its sessions.
4. Git merge and worktree cleanup remain separate manual actions.

## Future phase note

Spark capture and spark triage are deferred to Phase 2. They are not part of the first MVP release path documented here.

## Command surfaces (top bar + command palette)

Commands are available through:

- top-bar contextual actions in task and session views
- global command palette

Examples:

- create task
- start ad-hoc session
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
- Every session belongs to a task.
- No subtasks exist in v0; review and handoff stay on the same task.
- Tasks are execution-agnostic.
- Task status is manual and project-customizable.
- Sessions can change execution root during work.
- Collision warnings are advisory, not blocking.
