# Isagi

## What this is

Isagi is a desktop app for resumable worktree-based development environments. Electron is the client; the runtime owns operational work.

## Structure

- `apps/desktop` is the Electron shell.
- `apps/web` is the React frontend.
- `apps/runtime` is the local-or-remote runtime server.
- `packages/contracts` contains shared versioned API contracts and schemas.
- `packages/workflow-sdk` is the independently versioned public workflow authoring contract.
- `packages/workflow-verifier` owns workflow verification, build receipts, and the canonical scaffold.
- `apps/runtime/src/workflows` discovers, loads, and executes verified workflows.
- `apps/runtime/src/agent-sessions/harness/skill-content` is the source of the shipped `isagi-docs` skill for configuring Isagi and authoring workflows.
- `docs/issue-tracking-guidance.md` defines how epics and stories are represented in the repository's issue tracker, including how to create, retrieve, and amend them.

## Rules

- Always start by reading:
  - docs/engineering-guidance/README.md
  - docs/engineering-guidance/principles.md
  - docs/engineering-guidance/how-to-use.md
  - docs/adrs/README.md (use it as an index; read only ADRs relevant to the task)
  - Additionally, make sure to read any relevant engineering guidance files before starting to code.
- It is possible that the user doesn't know or remember the code and current architecutre. So always include relevant explaination to bring the user to the same level of understanding as you. Use simple language for this to keep cognitive burden low.
- Never hard-wrap prose in Markdown files. Keep each paragraph and list item on one source line.
- After code changes, run `pnpm check`. Each package has its own `check` command. Use `pnpm fix` to fix formatting issues.
- Do not run the `engineering-guidance-review` subagent when debugging, create mockups or just helping the user brainstorm.
- Never start long running processes like servers or run `pnpm run dev` or `pnpm run start`. Instead suggest the user to run those commands instead.
- Don't run state-changing Git commands unless the user explicitly asks; read-only Git (diffs, status, commit history, etc.) is allowed.
- We haven't launched yet, so prefer bold refactors for better maitainability and correctness over backwards compatibility.
- Isagi ships an agent skill, `isagi-docs`, that teaches a user's coding agent how to configure Isagi and author workflows. Its source is `apps/runtime/src/agent-sessions/harness/skill-content/`. Any change to Isagi's user-configurable **surface** must ship skill coverage in the same change: an index row in `SKILL.md` plus reference content.
- Workflow contract changes must keep the SDK exports/types, verifier behavior and receipt format, runtime loader, workflow documentation, shipped configuration skill, and canonical fixtures synchronized. Treat those surfaces as one cross-cutting public contract even though their package versions and release timing differ. We are talking about `@yourtechbudstudio/isagi-workflow-sdk` and `@yourtechbudstudio/isagi-workflow-verifier` packages
