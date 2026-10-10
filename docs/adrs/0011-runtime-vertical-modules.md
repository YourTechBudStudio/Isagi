# 0011-runtime-vertical-modules

status: proposed
date: 2026-10-09

## Decision

The runtime source (`apps/runtime/src`) is organized as deep vertical modules with narrow public surfaces, one shared infrastructure tree, and one composition root. Allowed dependencies are declared in one acyclic manifest and enforced by a checker.

`src/` contains exactly:

- `index.ts`, the process entry.
- `app/`, the composition root.
- `platform/<area>/`, domain-free shared infrastructure.
- Eleven vertical modules as top-level directories: `runtime-config`, `cli-access`, `projects`, `pty-processes`, `commands`, `editor`, `harnesses`, `environment`, `workspace`, `workflows`, `runtime-events`.

There is no `lib/`, `utils/` or `modules/` prefix, and no second, legacy structure next to the modules.

### Modules and their dependencies

Each module exclusively owns its behavior, tables, data-directory file areas, adapters, routes and tests.

| module           | owns                                                                                                                                                                                                                                                                                                                                                                                                                                  | allowed module deps                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `runtime-config` | the user runtime config file (`config.yaml`): service, policy, config schema (shipped as an asset), the client-settings route                                                                                                                                                                                                                                                                                                         | —                                                                                      |
| `cli-access`     | the `isagi` CLI inside terminals: shim writer, `tools/` data area, launch env, CLI-bundle asset                                                                                                                                                                                                                                                                                                                                       | —                                                                                      |
| `projects`       | the project/worktree registry every module foreign-keys to: tables `projects`, `worktrees`, `ProjectRepository`, the per-project `.isagi` config (schema, normalize, hash, summary, loader). No routes.                                                                                                                                                                                                                               | —                                                                                      |
| `pty-processes`  | disposable processes (ADR 0005): table `pty_processes`, backends, logs and log GC, process GC, foreground state, the generic PTY stream route, the shell-integration data area                                                                                                                                                                                                                                                        | `runtime-config`, `cli-access`                                                         |
| `commands`       | project commands: command state and run tables, launch, ports, dotenv, lifecycle, convergence, the command routes and log stream                                                                                                                                                                                                                                                                                                      | `projects`, `pty-processes`                                                            |
| `editor`         | Code Server provisioning (install, receipt, manifest asset, `editors/` area) and durable editor contexts (launch, readiness, probes); table `editor_contexts`; editor runtime routes                                                                                                                                                                                                                                                  | `projects`, `pty-processes`                                                            |
| `harnesses`      | agent harness integration (ADR 0007): catalog and definitions, per-harness adapters, artifacts/ledger area, lifecycle reducers, observation projection, the ledger observer, conversation reading, headless output, `isagi-docs` publication and skill content, host executable inventory, the control plane and its routes. No tables.                                                                                               | `runtime-config`, `pty-processes`, `editor`                                            |
| `environment`    | the durable worktree environment (ADR 0006, ADR 0008): surfaces, panes and focus; durable agent and terminal sessions (rows, status, lifecycle, attach tokens, restore, teardown, unplaced-session GC, attention); the projection of internal events to public runtime events; surface, session and attach routes. Tables `worktree_surfaces`, `surface_panes`, `worktree_environment_states`, `agent_sessions`, `terminal_sessions`. | `projects`, `pty-processes`, `editor`, `harnesses`                                     |
| `workspace`      | project/worktree lifecycle orchestration: register, relocate, reconcile, create/open/detach/delete, ordering, active context and `state.json`, snapshot, post-create setup hooks, path suggestions; setup tables; `projects.*`, `worktrees.*`, `workspace.*` and `paths.*` routes                                                                                                                                                     | `projects`, `pty-processes`, `commands`, `environment`                                 |
| `workflows`      | verified workflows: the seven `workflow_*` tables, structure, engine, operations, checkpoints, content store (ADR 0010), waits, the workflow SDK author bridge, `workflows.*` routes                                                                                                                                                                                                                                                  | `projects`, `runtime-config`, `pty-processes`, `harnesses`, `environment`, `workspace` |
| `runtime-events` | the public runtime-event WebSocket and its snapshot requests                                                                                                                                                                                                                                                                                                                                                                          | `environment`, `workflows`                                                             |

The declared graph, bottom-up, is acyclic:

```
runtime-events ─→ environment, workflows
workflows      ─→ workspace, environment, harnesses, pty-processes, runtime-config, projects
workspace      ─→ environment, commands, pty-processes, projects
environment    ─→ harnesses, editor, pty-processes, projects
harnesses      ─→ editor, pty-processes, runtime-config
editor         ─→ pty-processes, projects
commands       ─→ pty-processes, projects
pty-processes  ─→ runtime-config, cli-access
projects · runtime-config · cli-access   (platform only)
every module   ─→ platform/*;  platform areas never import modules;  only index.ts imports app/
```

The manifest is `apps/runtime/module-boundaries.json`. Changing it changes the architecture: every edit needs a one-line reason in the change description.

### Shared infrastructure (`platform/`)

Code enters `platform/` only when it names no product concept (no session, surface, command, workflow or project semantics beyond data shapes), has two or more domain consumers, and fits a named area. Platform never imports a module or `app/`. Two vocabulary exceptions exist, both closed data with no behavior: the `InternalEvent` union and `EntityLockKey`.

| area                   | contents                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/persistence` | the SQLite connection, data directory, migrations, the orphan-file helper (ADR 0010), sibling-order compaction                                                                     |
| `platform/events`      | the `InternalEvents` bus and `InternalEvent` union; the public `RuntimeEvents` bus                                                                                                 |
| `platform/http`        | endpoint and content-endpoint helpers, the error envelope, `RouteRuntime<R>`, platform infrastructure errors, origin checks, the WebSocket connection adapter, the API test server |
| `platform/diagnostics` | phase markers, the event-loop watchdog, the safe-diagnostic protocol, bounded text                                                                                                 |
| `platform/git`         | the Git adapter                                                                                                                                                                    |
| `platform/process`     | the only `node:child_process` users: user shell, shell launch and env, ANSI, `execCommand`, process groups                                                                         |
| `platform/fs`          | path canonicalization, filesystem errors                                                                                                                                           |
| `platform/locks`       | the entity lock                                                                                                                                                                    |
| `platform/net`         | the loopback port probe                                                                                                                                                            |
| `platform/fibers`      | the one periodic-loop helper                                                                                                                                                       |
| `platform/assets`      | the build-asset root helpers and the runtime package version; owners declare their own asset constants                                                                             |

Areas import each other only along declared area dependencies.

### Public-surface rule

- A module's cross-module surface is at most three root files: `index.ts` (runtime surface), `tables.ts` (Drizzle tables, table-owning modules only) and `testing.ts` (importable from test files only). Platform areas expose `index.ts` and `testing.ts`. Everything else, including sub-folders, is private.
- `index.ts` uses explicit named re-exports, never `export *`. It exports only: service classes other modules use, the module's `<Module>Layer`, tagged errors callers match on, types that appear in those signatures, port tags the module owns and port implementation layers (imported only by `app/`), background layers `app/` must start, and `register<Module>Routes`. Repositories, adapters, backends, factories and helpers are never exported; `ProjectRepository` is the one exception because it is the `projects` module's service.
- Anything `app/` or another module must run (startup work, snapshots) is a method on a public service, never a free `Effect` whose requirements include module-internal services.
- Sub-folder barrels are forbidden in production code. File names never repeat the module or parent-directory name as a prefix (`commands/commands.service.ts` becomes `commands/service.ts`).
- Test files are `*.test.ts`, anything under `tests/`, `testing.ts` and `*test-support.ts`. Production code never imports a test file. Tests may import public and `testing.ts` files of their module's transitive dependency closure; tests that need more live in `app/tests/`.
- Service ids are `isagi/runtime/<module>/<ClassName>`; platform services use `isagi/runtime/platform/<area>/<ClassName>`.

### Persistence

- Each table is declared in its owner's `tables.ts`. A `tables.ts` holds only `sqliteTable` definitions and indexes and imports only `drizzle-orm`, `@isagi/contracts` literal sets and other modules' `tables.ts` (for foreign keys, which always point down the graph).
- `drizzle.config.ts` globs `./src/*/tables.ts`. Splitting the schema produces no migration; existing migrations are untouched.
- `RuntimeDatabase` is schema-agnostic (`drizzle(client)` without a schema object), so platform does not import every module.
- Only the owning module writes a table (ADR 0008). Reads across declared dependencies are allowed; reading a table of a module above is impossible because it would be an upward import.
- The PTY garbage collector discovers which rows own a PTY process from SQLite foreign-key metadata (every column with a foreign key to `pty_processes.id`), not from a hard-coded owner list or a registration port. A new owner is protected by declaring that foreign key.

### Coordination between modules

Choose the first mechanism that fits:

1. **A downward call to a public service.** Example: `WorkspaceService` calls `CommandService`, `PtyService` and `SurfaceService`.
2. **An `InternalEvent` on the one platform bus.** Used when a lower module must react after the fact to something a higher module did, or when there are many subscribers.
3. **A port.** Used when a lower module needs an answer synchronously or inside its own transaction from a higher module. The lower module owns the `Context.Service` tag in its `index.ts`; the higher module exports the implementation layer from its `index.ts`; only `app/` wires it.

Exactly two ports exist. A new port needs an amendment row in this table.

| port                         | owner (lower) | implementation (higher)                          | purpose                                                                         |
| ---------------------------- | ------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `ProjectDeletionParticipant` | `workspace`   | `workflows` (`WorkflowProjectErasure`)           | erase a project's workflow rows inside workspace's project-deletion transaction |
| `HarnessObservationTargets`  | `harnesses`   | `environment` (`HarnessObservationTargetsLayer`) | list the agent sessions the harness ledger observer watches                     |

### Internal events

`platform/events/internal-events.ts` holds one closed union. Each variant keeps its payload and carries a doc comment `publishers: …; subscribers: …`. Adding a variant means adding that comment; reviewers check it.

| variant                                                                                | publishers                                           | subscribers                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `pty_process_{started,exited,failed,killed}`, `pty_foreground_command_{started,ended}` | pty-processes                                        | editor, commands, harnesses (observer), workflows, environment (projection) |
| `agent_session_changed`                                                                | environment, harnesses (observer)                    | environment (projection)                                                    |
| `agent_session_active_process_changed`                                                 | environment                                          | harnesses (observer)                                                        |
| `turn_started`, `turn_ended`, `turn_failed`                                            | harnesses (observer)                                 | workflows                                                                   |
| `terminal_session_changed`, `surface_changed`                                          | environment                                          | environment (projection)                                                    |
| `editor_context_changed`                                                               | editor, environment                                  | environment (projection)                                                    |
| `durable_session_deleted`                                                              | environment (session GC), workspace (cascade delete) | environment (projection)                                                    |
| `worktree_activation_change`                                                           | workspace                                            | commands                                                                    |
| `worktree_deleted`, `project_deleted`                                                  | workspace                                            | none in production; asserted by workspace tests                             |

The public `RuntimeEvents` bus is published by environment (projection), commands and workflows, and consumed by `runtime-events`.

### Composition root

`app/` is the only composition root and contains no capability behavior: no SQL, no domain rules, and no endpoint handlers except health (the runtime describing itself).

- Each service's `static layer` wires its own downward module dependencies by reference and leaves platform services and ports open. Each module's `index.ts` exports one `<Module>Layer`, a plain merge of the services its routes and dependents use plus its background layers (`runtime-config` has none).
- `app/layer.ts` merges the module layers, provides the platform layer and the two ports, and asserts at compile time that the resulting app layer has no open requirements.
- `app/http-server.ts` owns Fastify as a scoped layer and gives route registrars a `RouteRuntime<R>`; registrars are typed by their own module's services, so no module imports `app/`.
- `app/routes.ts` registers every module's routes; `app/startup.ts` runs cross-module startup in one explicit order using only public service methods.
- Cross-module integration tests live in `app/tests/`.

### Enforcement

`scripts/architecture/module-boundaries.mjs`, run by `scripts/architecture/index.mjs` from `pnpm lint`, checks the manifest. Test files are `*.test.ts`, `**/tests/**`, `**/testing.ts` and `*test-support.ts`.

| id  | rule                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | every source file under `apps/runtime/src` is inside a declared module or the composition root                                                                                         |
| R2  | a cross-module import targets a declared public file; test files may also target the module's `testing` file                                                                           |
| R3  | the target module is in the importer's declared dependencies (type-only imports included); test files may target the transitive closure                                                |
| R4  | production files never import a test file                                                                                                                                              |
| R5  | declared dependency names exist and the graph is acyclic                                                                                                                               |
| R6  | nothing outside the composition root imports it                                                                                                                                        |
| R7  | a production file never passes another module's table to `.insert(`, `.update(` or `.delete(`                                                                                          |
| R8  | a `tables.ts` imports only `drizzle-orm`, `drizzle-orm/*`, `@isagi/contracts` and other modules' `tables.ts`                                                                           |
| R9  | listed external packages (`node-pty`, `better-sqlite3`, `fastify`, `@fastify/websocket`, `@fastify/cors`, `node:child_process`) are imported only from listed paths; test files exempt |
| R10 | no `index.ts` below a module root and no `export *` in a module or area `index.ts` (production files)                                                                                  |
| R11 | no file basename starts with `<parent-directory-name>.`                                                                                                                                |
| R12 | every declared module path exists and contains `index.ts`                                                                                                                              |

oxlint's `import/no-cycle` catches file-level cycles inside a module. R9 is report-only until the remaining direct `node:child_process` users move onto `platform/process`; it is then enforced like the other rules.

## Motivation

Before this decision the runtime grew by technical layer and history: 27 top-level directories, a `lib/` catch-all, one central Drizzle schema imported everywhere, a 345-line hand-wired composition file, route files importing the composition root, and two-way couplings between surfaces and agent sessions. Changing one capability meant reading several directories, and nothing stopped a new upward import.

Vertical modules put a capability's behavior, data and tests in one place behind a small surface. The declared graph turns "who may depend on whom" into a reviewable file, and the checker turns it into a failing build instead of a review comment. `environment` is one module because surfaces and sessions co-own their reads in both directions; it matches ADR 0006's unit of a durable worktree environment. `projects` sits below everything because it is the only acyclic cut: commands, editor, environment and workflows need worktree lookups while workspace orchestration calls commands and environment. `harnesses` keeps catalog, inventory, observer and control plane together so adding a harness touches one module.

Ports are limited to two because each one is an inversion that readers must chase; events and downward calls are cheaper to understand.

## Consequences

- Common changes stay inside one module: add a harness (`harnesses/<name>/` + `harnesses/definitions.ts`), add a PTY backend (`pty-processes/adapters/`), change attention rules (`environment/agent-sessions/attention.ts`), add a command option (`commands/` + `projects/config/config-schema.ts`), add a workflow operation (`workflows/operations/`), add a data-directory file area (owning module + `platform/persistence` helper, ADR 0010).
- Adding a module, a dependency edge, a port or a table owner is an explicit edit to `module-boundaries.json` (and, for a port, to this ADR).
- `platform/` stays small; a helper with one consumer stays in that module.
- Table write ownership (ADR 0008) is machine-checked by R7.
- An owner of a PTY process must declare a foreign key to `pty_processes.id`, or the PTY GC will collect the process (ADR 0005).
- The runtime HTTP API, persisted data and migrations do not change because of this layout.

## Notes

- Rejected: splitting sessions from surfaces into separate modules (forces ports or rule moves in both directions), a `modules/` path prefix, a PTY-reference registration port (foreign-key metadata replaces it), open per-module event types (one annotated union stays), and replacing `worktree_activation_change` with a direct call.
- Rejected: enforcing boundaries from a unit test; the lint-time `scripts/architecture/` runner is used instead.
- Runtime Effect mechanics (service shape, layers, run sites, errors, logging) are ADR 0012 and `docs/engineering-guidance/effect-conventions.md`.
