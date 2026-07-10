# Isagi

## What this is

Isagi is a desktop app for resumable worktree-based development environments. Electron is the client; the runtime owns operational work.

## Structure

- `apps/desktop` is the Electron shell.
- `apps/web` is the React frontend.
- `apps/runtime` is the local-or-remote runtime server.
- `packages/contracts` contains shared versioned API contracts and schemas.

## Rules

- Always start by reading:
  - docs/engineering-guidance/README.md
  - docs/engineering-guidance/principles.md
  - docs/engineering-guidance/how-to-use.md
  - docs/adrs/README.md (use it as an index; read only ADRs relevant to the task)
  - Additionally, make sure to read any relevant engineering guidance files before starting to code.
- Never modify `CLAUDE.md` files directly; they are symlinks to `AGENTS.md` files, so edit the corresponding `AGENTS.md` instead.
- After code changes, run `pnpm check`. Each package has its own `check` command. Use `pnpm fix` to fix formatting issues.
- Do not run the `engineering-guidance-review` subagent when debugging, create mockups or just helping the user brainstorm.
- Use the Effect library (`effect`) for operational implementation code where async work, failure, retries, dependencies, resources, or lifecycle matter. Follow package-specific `AGENTS.md` files for local Effect scope.
- Never start long running processes like servers or run `pnpm run dev` or `pnpm run start`. Instead suggest the user to run those commands instead.
- Don't run state-changing Git commands unless the user explicitly asks; read-only Git (diffs, status, commit history, etc.) is allowed.
- App and internal packages are tightly coupled and released simultaneously, so feel free to do bold refactors and break compatiblity at their boundaries for better maintainablity and correctness. The public `@yourtechbudstudio/isagi-workflow-sdk` and `@yourtechbudstudio/isagi-workflow-verifier` packages are independently versioned exceptions and must not be bumped for unrelated app releases.
- We haven't launched yet, so prefer bold refactors for better maitainability and correctness over backwards compatibility.
- Isagi ships an agent skill, `configure-isagi`, that teaches a user's coding agent how to configure Isagi. Its source is `apps/runtime/src/agent-sessions/harness/skill-content/`. Any change to Isagi's user-configurable **surface** must ship skill coverage in the same change: an index row in `SKILL.md` plus reference content. A surface is a new config file, a new discovery root, a new top-level config section, or a new configurable feature area — and it includes anything currently named in `SKILL.md`'s "does not configure today" list, which becomes a lie the day that feature ships. Adding a field to an existing config schema needs no skill work: the schema source is embedded verbatim and `SKILL.md` declares it authoritative over the prose.
- Workflow contract changes must keep the SDK exports/types, verifier behavior and receipt format, runtime loader, workflow documentation, shipped configuration skill, and canonical fixtures synchronized. Treat those surfaces as one cross-cutting public contract even though their package versions and release timing differ.
