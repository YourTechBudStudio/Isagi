# Coding Workflow Journey (MVP)

**Last updated:** 2026-04-28

## Journey goals

- Help the user recover project momentum when direction is unclear.
- Keep execution resumable once the work is concrete.
- Preserve planning context in Git-backed `.isagi/` artifacts.
- Support parallel coding threads without hiding runtime collisions.

## Actors and surfaces

- **User** - confirms direction, asks for Discovery/Shaping, starts sessions, and changes statuses.
- **Isagi UI** - shows project momentum, planning artifacts, sessions, and execution controls.
- **Backend runtime** - owns session state, harness bindings, execution roots, worktrees, and collision visibility.
- **Agent session** - performs Discovery, Shaping, scratch exploration, or task execution.

## Entry posture: open app and resume work

1. Home opens as a resume-first orientation surface.
2. Recent resumable sessions are the primary jump-in targets.
3. Sessions may include task execution, scratch exploration, Discovery, or Shaping.
4. If nothing is resumable, the user can open a project and ask what to continue next.

## Scenario A: Register a project

1. User runs an `Add project` command.
2. User provides an existing git repo path visible to the active backend.
3. Isagi validates that the directory is a git repo.
4. User confirms or edits the project name.
5. The project is available for sessions and `.isagi/` planning artifacts.

Detailed registration guidance: `docs/product/screens/project-registration-flow.md`.

## Scenario B: Discover the next milestone

1. User opens a project and asks what to work on next.
2. Discovery grounds itself in project context, existing milestones, tasks, sparks, and relevant files.
3. Discovery decides whether to continue the current milestone or propose a new one.
4. Discovery proposes milestone direction in chat first.
5. User confirms, rejects, or redirects the proposal.
6. Only after confirmation does the agent create or update milestone artifacts under `.isagi/`.

## Scenario C: Shape a milestone into tasks

1. User chooses or confirms a milestone.
2. Shaping uses that milestone as the center of gravity.
3. Shaping proposes a few reviewable agentic task chunks in chat.
4. User confirms, rejects, or redirects the task shape.
5. Only after confirmation does the agent create or update task artifacts under `.isagi/`.

Task quality guidance lives in `docs/product/planning-artifacts.md`.

## Scenario D: Start task-backed execution

1. User opens or creates a milestone-linked or project-level task artifact.
2. User starts a task-linked session.
3. Session opens from the project repo root or selected execution root.
4. Agent work begins with task and project context available.
5. Task status moves through project-defined statuses grouped into `To-do`, `In progress`, and `Done`.

## Scenario E: Start scratch exploration

1. User starts a scratch session against a project.
2. Isagi opens a session without requiring a task.
3. The session can answer questions, inspect context, or explore ideas without creating backlog noise.
4. Useful outcomes may later become sparks, milestones, or tasks after user confirmation.

## Scenario F: Choose execution mode

1. Session starts from the project repo or selected execution root.
2. User chooses to stay on the current branch, create/use a managed worktree, or decide interactively.
3. If a managed worktree is selected, Isagi may create it automatically.
4. Merge and worktree cleanup remain manual in v0.

## Scenario G: Continue across sessions

1. A task or project may accumulate multiple sessions.
2. Sessions are peers; none is primary by default.
3. One session may implement while another reviews or explores follow-up direction.
4. Sessions can be manually closed when no longer relevant.

## Scenario H: Execution root and collision awareness

1. During a session, the user may switch branches or move to/from a managed worktree.
2. If the execution root path changes, Isagi closes the current session and creates a new one bound to the new directory.
3. Isagi warns when another active or recent idle session shares the same execution directory.
4. Warnings are advisory, not blocking.

## Command surfaces

Commands are available through contextual actions and the global command palette.

Examples:

- discover next milestone
- shape milestone into tasks
- create spark
- start task session
- start scratch session
- change task status
- switch execution root / create worktree

## Invariants checklist

- MVP projects map to existing git repos.
- Durable planning artifacts live under `.isagi/`.
- Files are the source of truth for planning state.
- Backend owns runtime/session state.
- Milestone is the primary continuation object.
- Discovery and Shaping are prompt-template modes.
- Discovery and Shaping do not write files until user confirmation.
- Tasks are execution-agnostic.
- Sessions are directory-bound.
- Collision warnings are advisory.
