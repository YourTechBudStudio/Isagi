# ADRs

Read this file before planning/coding. Read listed ADRs only when relevant.

## Status

- accepted: binding
- proposed: not binding
- superseded: read replacement
- rejected: historical

## Index

| file                                                        | status   | read_when                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0001-state-ownership-and-active-context-restoration.md`    | accepted | state ownership; runtime/client contracts; workspace snapshot/mutations; active context; frontend server-state caching; React Query/Zustand split                                                                              |
| `0002-mutation-results-state-refresh-and-operation-cost.md` | accepted | mutation response shape; server-state refresh; optimistic updates; hidden reconciliation or discovery work                                                                                                                     |
| `0003-workbench-actions-command-palette.md`                 | accepted | workbench actions; command palette; keyboard shortcuts; rail/pane controls; shared frontend action workflows                                                                                                                   |
| `0004-localized-action-feedback.md`                         | accepted | user-visible action feedback placement; command/palette errors; partial-success results; toasts vs inline/localized feedback                                                                                                   |
| `0005-disposable-pty-processes.md`                          | accepted | PTY/process lifecycle; node-pty/tmux semantics; process restoration boundaries; PTY table/API naming                                                                                                                           |
| `0006-durable-worktree-environment-entities.md`             | accepted | worktree environment restoration; durable agent/terminal/browser/editor/artifact entities; surface/pane continuity; lazy process recreation                                                                                    |
| `0007-per-invocation-harness-integration.md`                | accepted | agent harness adapters; hooks/plugins/extensions; session ID capture; resume commands; avoiding global/user/project config mutation; raw-native event ledger + read-time observation (attention, turn lifecycle, conversation) |
| `0008-mutation-ownership-and-read-composition.md`           | accepted | runtime service mutation ownership; read-side joins/projections; source facts vs derived product state; durable entities and replaceable resources                                                                             |
