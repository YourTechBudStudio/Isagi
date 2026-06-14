# ADRs

Read this file before planning/coding. Read listed ADRs only when relevant.

## Status

- accepted: binding
- proposed: not binding
- superseded: read replacement
- rejected: historical

## Index

| file                                                        | status   | read_when                                                                                                                                         |
| ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001-state-ownership-and-active-context-restoration.md`    | accepted | state ownership; runtime/client contracts; workspace snapshot/mutations; active context; frontend server-state caching; React Query/Zustand split |
| `0002-mutation-results-state-refresh-and-operation-cost.md` | accepted | mutation response shape; server-state refresh; optimistic updates; hidden reconciliation or discovery work                                        |
| `0003-workbench-actions-command-palette.md`                 | accepted | workbench actions; command palette; keyboard shortcuts; rail/pane controls; shared frontend action workflows                                      |
| `0004-localized-action-feedback.md`                         | accepted | user-visible action feedback placement; command/palette errors; partial-success results; toasts vs inline/localized feedback                      |
