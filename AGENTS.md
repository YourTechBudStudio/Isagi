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
- After code changes, run `pnpm check`. Each package has its own `check` command.
- Do not run the `engineering-guidance-review` subagent when debugging, create mockups or just helping the user brainstorm.
- Use the Effect library (`effect`) for operational implementation code where async work, failure, retries, dependencies, resources, or lifecycle matter. Follow package-specific `AGENTS.md` files for local Effect scope.
- Never start long running processes like servers or run `pnpm run dev` or `pnpm run start`. Instead suggest the user to run those commands instead.
- All packages are tightly coupled and released simultaneously, so feel free to do bold refactors and break compatiblity at their boundaries for better maintainablity and correctness.
- We haven't launched yet, so prefer bold refactors for better maitainability and correctness over backwards compatibility.
