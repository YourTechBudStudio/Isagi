# Isagi

Isagi is a desktop app for resumable worktree-based development environments. Electron is only a client: the runtime (`apps/runtime`, local or remote) owns all operational work, including Git, worktrees, PTYs, commands, agent sessions, workflows and persistence.


## Rules

- Always start by reading:
  - `docs/engineering-guidance/README.md`
  - `docs/engineering-guidance/principles.md`
  - `docs/engineering-guidance/how-to-use.md`
  - `docs/adrs/README.md` (an index: read only the ADRs relevant to the task)
  - any engineering guidance relevant to the change, before you start coding.
- The user may not know or remember the code and current architecture. Always include the explanation needed to bring them to your level of understanding, in simple language that keeps their cognitive load low.
- Never hard-wrap prose in Markdown files. Keep each paragraph and list item on one source line.
- After code changes, run `pnpm check` (each package also has its own `check` command). Use `pnpm fix` to fix formatting issues.
- Never run `pnpm run dev` or `pnpm run start` to run the Isagi app yourself; suggest that the user run them.
- Don't run state-changing Git commands unless the user explicitly asks. Read-only Git (diffs, status, commit history, etc.) is allowed.
- Isagi hasn't launched yet, so prefer bold refactors for maintainability and correctness over backwards compatibility.
- Isagi ships an agent skill, `isagi-docs`, that teaches a user's coding agent how to configure Isagi and author workflows. Its source is `apps/runtime/src/harnesses/skill-content/`. Any change to Isagi's user-configurable **surface** must ship skill coverage in the same change: an index row in `SKILL.md` plus reference content.
- The workflow SDK and verifier (`@yourtechbudstudio/isagi-workflow-sdk`, `@yourtechbudstudio/isagi-workflow-verifier`) form one cross-cutting public contract with the runtime loader, workflow documentation, the `isagi-docs` skill and the canonical fixtures. A change to SDK exports or types, verifier behavior or the receipt format keeps all of those in sync, even though their package versions and release timing differ. Do not bump either package for unrelated app releases.
