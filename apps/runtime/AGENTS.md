# Runtime

## What this is

The local-or-remote Isagi runtime. It owns Git, worktrees, PTYs, commands, agent sessions, workflows, configuration, and persistence.

## Structure

`src/` is organized as vertical modules over a shared `platform/` and one composition root (ADR 0011). A module owns its behavior, tables, data-directory file areas, adapters, routes and tests. Other modules see only its `index.ts`, its `tables.ts` (table owners) and, from tests, its `testing.ts`; everything else, including sub-folders, is private.

- `src/index.ts` is the process entry: it launches `MainLayer` with `runMain` (`app/run-main.ts`) and the runtime logger provided outermost.
- `src/app/` is the composition root and holds no capability behavior: `layer.ts` (`PlatformLayer`, `ModulesLayer`, `PortsLayer`, `AppLayer`), `http-server.ts` (Fastify as a scoped layer, the request `FiberSet` and the `RouteRuntime` routes run on), `routes.ts`, `startup.ts` (ordered cross-module startup and the ready line), `logger.ts` (`RuntimeSettings`, `RuntimeLogger`), `health.ts`, `startup-diagnostics.ts`. Cross-module integration tests live in `app/tests/`.
- `src/platform/<area>/` is domain-free infrastructure with two or more consumers: `persistence`, `events`, `http`, `diagnostics`, `git`, `process`, `fs`, `locks`, `net`, `fibers`, `assets`. Platform never imports a module or `app/`.

The modules and what each owns are below. Which modules a module may depend on is declared only in `module-boundaries.json` (`modules.<name>.dependsOn`), the source of truth that `pnpm -C apps/runtime lint:modules` checks; read it there rather than from a copy. ADR 0011 shows the graph as decided.

| module           | owns                                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-config` | the user runtime config file (`config.yaml`), its policy and schema (shipped as an asset), the client-settings route                                                                                                                    |
| `cli-access`     | the `isagi` CLI (`apps/cli`) inside terminals: writes the versioned shim under the data root's `tools/` at startup and gives every PTY launch the shim's `bin` on `PATH` and `ISAGI_RUNTIME_URL`                                        |
| `projects`       | the project/worktree registry (`projects`, `worktrees` tables, `ProjectRepository`) and the per-project `.isagi` config (`config/`). No routes.                                                                                         |
| `pty-processes`  | disposable processes (ADR 0005): `pty_processes`, backends (`adapters/`), logs and log GC, process GC, foreground state, the generic PTY stream route, the shell-integration area                                                       |
| `commands`       | project commands: command state and run tables, launch, ports, dotenv, lifecycle, convergence, the command routes and log stream                                                                                                        |
| `editor`         | Code Server: `provisioning/` (install, receipt, manifest) and `contexts/` (durable editor contexts, launch, readiness, probes); `editor_contexts`; the editor runtime routes                                                            |
| `harnesses`      | agent harness integration (ADR 0007): definitions, per-harness `claude/`, `codex/`, `opencode/`, `pi/`, adapter registry, artifacts and ledger, the ledger observer, conversation reading, `inventory/`, `control-plane/`, `isagi-docs` |
| `environment`    | the durable worktree environment (ADR 0006): `surfaces/`, panes and focus, `agent-sessions/`, `terminal-sessions/`, `sessions/` (lifecycle, attach, restore, teardown, GC), the runtime-event projection                                |
| `workspace`      | project/worktree lifecycle orchestration, ordering, active context and `state.json`, snapshot, `setup/` (post-create hooks), path suggestions; the `projects.*`, `worktrees.*`, `workspace.*` and `paths.*` routes                      |
| `workflows`      | verified workflows: `structure/`, `engine/` (including the SDK `author-bridge.ts`), `operations/`, `checkpoints/`, `store/` (content area, ADR 0010), `waits/`, the `workflow_*` tables and routes                                      |
| `runtime-events` | the public runtime-event WebSocket and its snapshot requests                                                                                                                                                                            |

Every module may also use `platform/*`. `WorkspaceService` (`workspace/service.ts`) composes private files split along its seams (`project-lifecycle.ts`, `worktree-open.ts`, `worktree-delete.ts`, `reconcile.ts`, `active-context.ts`); `errors.ts`, `project-guards.ts` and `api-reasons.ts` keep that split acyclic and `api.ts` readable.

- `src/harnesses/skill-content` contains the handwritten `isagi-docs` skill source. `packages/workflow-verifier/fixtures/minimal-workflow` is its canonical workflow scaffold.
- `module-boundaries.json` declares the modules, their allowed dependencies, table owners and which paths may import `node-pty`, `better-sqlite3`, Fastify and `node:child_process`. Run `pnpm -C apps/runtime lint:modules`; adding a module or dependency means editing `module-boundaries.json` in the same change, with a one-line reason, and updating ADR 0011's module table and graph (a new module also gets a row in the table above).
- `dist/` is generated build output.
- `drizzle/` contains Drizzle Kit-generated migration artifacts. Do not edit generated migration files by hand; change the owning module's `tables.ts` and regenerate migrations instead with `pnpm -C apps/runtime db:generate` (it runs `drizzle-kit generate` with the `import` export condition the workflow SDK needs).

## Sessions and PTY processes

- Durable worktree entities (`agent_sessions`, `terminal_sessions`) sit above disposable PTY process incarnations (`pty_processes`). A durable session owns continuity and a sticky `active_pty_process_id`; the PTY process is transport only and is replaced freely. See ADRs 0005 and 0006.
- The PTY process layer (`src/pty-processes`) is generic: command, args, cwd, env, backend refs, logs, write/resize/kill, status. It must not import or branch on harness semantics. Harness adapters (`src/harnesses/<harness>/adapter.ts`, registered via `src/harnesses/registry.ts`) build the generic launch envelope.
- `node-pty` is the primary PTY backend. `tmux` is a legacy/optional PTY process backend only — it is one transport for a process incarnation, not a restoration or continuity mechanism. Restoration comes from durable sessions plus latest observed harness session ids, never from a backend's own session persistence.
- The PTY GC finds the rows that own a process from foreign keys to `pty_processes.id`; a new owner must declare that foreign key.

## Effect scope

- Use Effect as the default substrate for operational work: Git, worktrees, commands, PTYs, agent harnesses, persistence, retries, config, diagnostics, and runtime services. Follow `docs/engineering-guidance/effect-conventions.md` and ADR 0012.
- Services are `Context.Service` classes with ids `isagi/runtime/<module>/<Class>` (platform: `isagi/runtime/platform/<area>/<Class>`). Each `static layer` wires its own module dependencies and leaves platform services and the two ports open; `app/layer.ts` provides them once.
- Effects run only at the process entry, the HTTP/WebSocket boundary (`RouteRuntime`, run in `platform/http/route-runtime.ts`) and the workflow engine; `scripts/architecture/effect-run-sites.json` is the allowlist `pnpm lint` checks.
- Anything a service starts that outlives a call belongs to its layer scope. Periodic work uses `runPeriodically` (`platform/fibers`); no `setTimeout`/`setInterval`, no `Effect.forkDetach`.
- Log with `Effect.log*`; `console.*` is a lint error in `src/` (`apps/runtime/.oxlintrc.json`, which also enables `import/no-cycle`).
- Route handlers use `registerApiEndpoint`/`registerContentEndpoint` from `platform/http` and map their module's tagged errors with `catchTags` next to the endpoint.
