# Principles

These principles are intentionally small and durable. Detailed review questions live in the lens docs.

## Optimize For Future Change

Prefer designs that keep the next product slice easy to add without freezing architecture too early. Isagi is pre-MVP, so clean internal evolution is more valuable than preserving incidental internal compatibility.

## Preserve Source-Of-Truth Boundaries

Keep ownership clear. The runtime owns operational state. Git remains the source of truth for repository and worktree facts where practical. The web app owns React UI without Electron assumptions. Desktop owns native shell concerns. Contracts describe shared behavior without implementation.

## Make Operational Work Explicit

Work that can fail, block, retry, allocate resources, depend on services, spawn processes, or outlive a single call should make those facts visible in its type, boundary, and lifecycle. Use Effect as Isagi's operational substrate, not as a universal style for pure code.

## Prefer Deep Modules With Narrow Public Surfaces

Concentrate complexity behind clear interfaces. A deep module may contain multiple focused internal files; depth means callers see a small, stable surface, not that everything lives in one huge file.

## Organize Internals For Human Navigation

Code should be easy for a human to trace. Group related files by concept, responsibility, platform, lifecycle, or flow. Large files are acceptable only when they remain single-purpose and reviewable.

## Make Real Boundaries Explicit

Use explicit contracts and interfaces where behavior crosses packages, runtime/client boundaries, platform variants, persisted data, public APIs, integrations, or user-visible expectations. Avoid interface ceremony for tiny local helpers or one-off implementation details.

## Reuse To Prevent Drift

Actively look for similar functions, modules, and components. Reuse or refactor when similarity represents the same product behavior, visual pattern, lifecycle rule, or contract concept. Do not reuse in ways that weaken boundaries, readability, or local reasoning.

## Keep Behavior Honest And Visible

Do not present uncertain, partial, failed, or degraded behavior as success. Restoration, command execution, session state, attention signals, and missing artifacts should be visible in the product when they matter to the user.

## Make Runtime Failures Diagnosable

Early users need to report problems that can be debugged remotely. Runtime errors, process failures, Git/worktree problems, and integration degradation should expose enough context through UI, logs, or structured state to understand what failed and where.

## Treat User-Visible Behavior As Engineering Behavior

When a change affects what the user sees, trusts, resumes, or acts on, review it as engineering correctness, not as cosmetic polish.

## Let Verification Match Risk

Use enough verification to make the change trustworthy. A small copy change does not need the same evidence as a runtime lifecycle change, but risky behavior should not ship on optimism.

## Make Completed Work Easy To Review And Trust

Changes should leave a clear path through the code, an understandable explanation of behavior, and useful evidence of verification. Working code that is hard to review is usually a concern, even when it runs.
