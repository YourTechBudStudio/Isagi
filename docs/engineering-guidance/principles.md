# Principles

These principles are intentionally small and durable. Review questions live in the lenses.

## Optimize For Future Change

Prefer designs that keep the next product slice easy to add without freezing architecture too early. Isagi is pre-MVP, so clean internal evolution beats compatibility: migrate callers and delete old paths instead of adding shims or dual systems. Preserve compatibility only at real boundaries: released user data, public APIs or contracts used outside the repo, integrations or deployment behavior users rely on, and behavior early users already depend on.

## Keep Ownership And Sources Of Truth Clear

Every durable or user-visible fact has one clear owner, and persistence location, caching and UI state follow that ownership instead of hiding it. The runtime owns operational state. Git and the filesystem are the source of truth for repository and worktree facts where practical. The web app owns the React UI without Electron assumptions. Desktop owns native shell concerns. Contracts describe shared behavior and wire shapes without implementation.

## Keep State Flow Causal And Proportionate

State changes have clear causes, bounded effects, and a cost that matches the triggering action. Avoid hidden transitions, broad side effects, and expensive work behind APIs that look lightweight.

## Make Operational Work And Its Failures Explicit

Work that can fail, block, retry, hold resources, depend on services, spawn processes or outlive a call makes those facts visible in its type, boundary and lifecycle. Expected failures are named, structured and small in vocabulary, and are mapped to contract errors at API boundaries; unexpected defects stay distinct from them. ADR 0012 records how Isagi does this with Effect; it is the substrate for operational work, not a style for pure code.

## Use Narrow Types Where Mixups Matter

When plain strings or numbers would make identifiers, refs, paths or state variants easy to confuse, use a narrower shape: literal unions, tagged variants, or named fields instead of positional same-typed arguments. Do not add type ceremony where nothing can be mixed up.

## Prefer Deep Modules That Humans Can Navigate

Concentrate complexity behind small, stable public surfaces. Depth is not one huge file: a deep module may hold several focused files, grouped by concept, responsibility, platform, lifecycle or flow so a human can trace the main path. Large files are fine only while they stay single-purpose and reviewable.

## Make Real Boundaries Explicit

Use explicit contracts and interfaces where behavior crosses packages, the runtime/client boundary, platform variants, persisted data, public APIs, integrations or user expectations. API contracts make request, response and error shapes explicit enough for clients to handle success and failure deliberately. Skip interface ceremony for small local helpers.

## Reuse To Prevent Drift

Look actively for similar functions, modules and components. Reuse or refactor when the similarity is the same product behavior, visual pattern, lifecycle rule or contract concept, but not in ways that weaken boundaries or local reasoning.

## Keep User-Visible Behavior Honest

What the user sees, trusts, resumes or acts on is engineering behavior, not polish. Never present uncertain, partial, failed or degraded behavior as success; restoration, command execution, session state, attention signals and missing artifacts are visible when they matter. On user-facing surfaces, fidelity to Isagi's design language and voice is part of the product.

## Make Runtime Failures Diagnosable

Early users must be able to report problems that can be debugged remotely. Runtime, process, Git/worktree, API and integration failures expose enough context, through UI, logs, structured API errors or structured state, to tell what failed and where.

## Make Completed Work Easy To Trust

Verification matches risk: a copy change needs less evidence than a runtime lifecycle change, but risky behavior never ships on optimism. A change leaves a clear path through the code, an honest explanation of behavior and evidence of what was verified. Working code that is hard to review is usually a concern, even when it runs.
