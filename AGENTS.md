# Isagi

## What this is

Isagi is a desktop app for resumable worktree-based development environments. Electron is the client; the runtime owns operational work.

## Structure

- `apps/desktop` is the Electron shell.
- `apps/web` is the React frontend.
- `apps/runtime` is the local-or-remote runtime server.
- `packages/contracts` contains shared oRPC contracts and schemas.

## Rules

- After code changes, run `pnpm check`. Each package has its own `check` command.
- Never start long running processes like servers or run pnpm run dev or pnpm run start. Instead suggest the user to run those commands instead.
