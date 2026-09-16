---
name: isagi-docs
description: Configure Isagi projects and runtime settings, and author or repair Isagi workflows. Use for worktree hooks, commands and ports, harness policy, terminal history, scrollback and cache retention, workflow discovery, graph authoring, and workflow verification or recovery. Do not use for ordinary development work merely because it runs inside Isagi.
---

# Configure Isagi and author workflows

Read only the references matching the request. Paths in these references are relative to this skill unless stated otherwise.

| Request                                                                                 | Read                                                                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Git worktree setup: copying, linking, or running hooks (`worktrees`)                    | [Project config](references/config-project.md)                                                                             |
| Git or folder project `commands`, fixed ports, allocated ports, and HTTP URLs           | [Project config](references/config-project.md)                                                                             |
| Terminal backend (`pty`), terminal history, scrollback, or cache retention (`terminal`) | [Global config](references/config-global.md)                                                                               |
| Harness availability or Docs installation (`harnesses`)                                 | [Global config](references/config-global.md)                                                                               |
| Additional workflow discovery roots (`workflows.additionalDirectories`)                 | [Global config](references/config-global.md)                                                                               |
| Creating, modifying, or verifying workflows and composing graphs                        | [Workflow authoring](references/workflows.md)                                                                              |
| Agent sessions, headless work, prompts, or judgments within a workflow                  | [Workflow authoring](references/workflows.md) and [Agent work](references/workflow-agents.md)                              |
| Repairing saved workflow runs or reasoning about Resume and Retry                       | [Workflow recovery](references/workflow-recovery.md); also [Workflow authoring](references/workflows.md) when editing code |

Follow an explicit user-provided target path. Configuration locations and workflow discovery defaults are in the relevant reference. For exact configuration fields, consult its linked schema; for workflow signatures, consult the installed SDK declarations. Report unsupported requests against those sources rather than inferring support from this index alone.
