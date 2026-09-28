---
name: isagi-docs
description: Configure Isagi, author or repair Isagi workflows, verify workflow packages, and investigate or reconstruct runs with the isagi CLI. Do not use for ordinary development work merely because it runs inside Isagi.
---

# Configure Isagi and author workflows

Read only the references matching the request. Paths in these references are relative to this skill unless stated otherwise.

| Request                                                                                                                               | Read                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Git worktree setup: copying, linking, or running hooks (`worktrees`)                                                                  | [Project config](references/config-project.md)                                                                             |
| Git or folder project `commands`, fixed ports, allocated ports, and HTTP URLs                                                         | [Project config](references/config-project.md)                                                                             |
| Terminal backend (`pty`), terminal history, scrollback, or cache retention (`terminal`)                                               | [Global config](references/config-global.md)                                                                               |
| Harness availability or Docs installation (`harnesses`)                                                                               | [Global config](references/config-global.md)                                                                               |
| Additional workflow discovery roots (`workflows.additionalDirectories`)                                                               | [Global config](references/config-global.md)                                                                               |
| Creating, modifying, or verifying workflows and composing graphs                                                                      | [Workflow authoring](references/workflows.md)                                                                              |
| Choosing or creating the worktree and surface a workflow runs in (`environment`, placement overrides, preparation failures)           | [Workflow environments](references/workflow-environments.md)                                                               |
| Agent sessions, headless work, prompts, or judgments within a workflow                                                                | [Workflow authoring](references/workflows.md) and [Agent work](references/workflow-agents.md)                              |
| Pause, Resume, Retry, app restarts, or making a workflow heal itself (self-retry loops, asking the user) | [Workflow recovery](references/workflow-recovery.md); also [Workflow authoring](references/workflows.md) when editing code |
| Placing checkpoints, choosing what to capture, scope names, missing paths, commits and their limits | [Workflow checkpoints](references/workflow-checkpoints.md) |
| Investigating runs from the command line (`isagi` CLI): execution tree, prompts and replies, plan versions across checkpoints, events | [CLI investigation](references/cli-investigate-runs.md) |
| Exporting a checkpoint to a new worktree or folder, and launching a fresh run in it (`isagi` CLI) | [CLI reconstruction](references/cli-reconstruct-and-launch.md) |

Follow an explicit user-provided target path. Configuration locations and workflow discovery defaults are in the relevant reference. For exact configuration fields, consult its linked schema; for workflow signatures, consult the installed SDK declarations. Report unsupported requests against those sources rather than inferring support from this index alone.
