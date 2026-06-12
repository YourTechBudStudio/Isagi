# How To Use This Guidance

Use this guidance as a question set during coding and review. It should help catch drift from Isagi's product model, architecture boundaries, supportability goals, and human-readable code standards.

## For Coding Agents

Before editing, identify which lenses are relevant to the change. During implementation, keep the relevant lens questions nearby instead of treating them as a final checklist.

Several lenses intentionally meet around stateful runtime/client work. Keep their jobs distinct: use `boundaries-and-contracts.md` to decide who owns a fact or API boundary, `state-flow-causality-and-operational-cost.md` to decide whether the transition is caused by the right action with appropriate scope and cost, and `runtime-behavior-and-diagnostics.md` to review lifecycle, failure, cancellation, and diagnosability once operational work exists.

`product-behavior-and-ux.md` and `design-fidelity-and-voice.md` also meet on user-facing surfaces. Keep them distinct: product-behavior asks whether the surface is honest and useful for the user's next action; design-fidelity asks whether it looks and sounds like Isagi. When a change touches user-facing UI, marketing surfaces, or user-facing copy, load the `design-system` skill and review against it.

Prefer the smallest correct change that preserves the product model and keeps the code easy to follow. If a cleaner internal interface requires migrating callers, migrate them rather than adding compatibility shims, unless a real external boundary depends on the old behavior.

For operational implementation code, prefer Effect-shaped internals and run them at framework or process boundaries. Expected domain and operational failures should usually be tagged and structured rather than thrown as generic errors. As an operational domain grows, prefer explicit services and layers for IO, config, persistence, Git, process, runtime-client, or adapter dependencies. Use branded or otherwise narrow domain types where plain primitives make important targets easy to mix up.

Do not wrap pure helpers, schemas, or presentational code in Effect just to make the code look consistent. Schema-backed contracts remain descriptive boundary artifacts even when they use Effect Schema; do not expose operational Effect concepts, services, layers, fibers, or runtime error classes across the API boundary.

When the change is complete, report what changed, what was verified, and any known risk or follow-up. Do not claim confidence that the evidence does not support.

## For Review Agents

Review the change against each relevant lens. The lenses are equal priority; do not skip a lens just because it often produces fewer findings.

Prefer findings that explain consequence. A good finding says what could break, drift, become hard to debug, or become hard to change.

Use the lens-specific severity mapping. When two severities seem plausible, choose the lower severity unless the consequence is concrete and material. If a finding could fit multiple lenses, report it under the lens that best describes the primary failure rather than duplicating it.

## Effect Adoption Posture

Effect is Isagi's substrate for operational work, not its universal programming style. Use Effect primitives to make operational facts visible: failure, dependencies, lifecycle, resources, cancellation, concurrency, and domain identity.

Use this maturity model as review orientation, not as a checklist:

- **Tier 0: Non-operational code** - pure helpers, constants, schemas, descriptive contracts, and presentational rendering. Keep this plain TypeScript or React.
- **Tier 1: Local Effect** - a contained async, failure, retry, timeout, validation, or parsing flow that runs at a nearby boundary.
- **Tier 2: Effect services/layers** - operational domains with dependencies that should be testable, replaceable, and explicit, such as Git, config, persistence, runtime clients, process adapters, or harness integrations.
- **Tier 3: Scoped runtime systems** - long-lived resources or concurrent systems that need scopes, fibers, queues, streams, supervisors, interruption, or structured shutdown.

Isagi should aim for **Tier 2 by default in operational code** and move to **Tier 3 where lifecycle complexity justifies it**. Runtime orchestration, PTYs, commands, agent sessions, restoration, and process supervision are likely Tier 3 territory. Pure schemas, descriptive contracts, presentational rendering, and tiny local helpers are not.

Use these primitives where they protect real reasoning:

- **Tagged data/errors** for expected failures, messages, findings, events, or state variants that callers are meant to distinguish.
- **Services and layers** for operational dependencies, not for every group of functions.
- **Scopes, fibers, queues, streams, supervisors, and interruption** when work can outlive one request or component interaction.
- **Branded or opaque domain types** for identifiers, refs, paths, tokens, or other primitives that cross boundaries or could be confused in dangerous ways.

Contracts are the exception boundary: they may use Effect Schema for serializable DTOs, but they must not expose runtime services, layers, fibers, Effect error classes, or domain implementation internals.

## Severity Semantics

- **Blocker** - material divergence from guidance; must fix before returning the change; re-review after the fix.
- **Concern** - real consequence, but not necessarily a stop-ship defect; fix directly when clear or surface the tradeoff.
- **Nit** - optional improvement; terminal and never a reason for re-review on its own.

Hard-to-review working code is usually a **Concern**, not a **Blocker**, unless the structure makes behavior ownership, runtime lifecycle, or correctness impossible to assess.

## Pre-MVP Interface Evolution

Before the first MVP, Isagi should favor clean internal interfaces over compatibility layers.

Preserve compatibility deliberately at real boundaries:

- released user data
- public APIs or contracts used outside the repo
- integrations or deployment behavior users rely on
- behavior already depended on by early users

For private internals, prefer migrating callers, deleting obsolete paths, and avoiding dual systems.

## Review Output

Useful review output is concise and consequence-driven:

- findings ordered by severity
- file and line references when available
- why the issue matters for Isagi
- what evidence was used
- what was not verified

Avoid restating the whole guidance in every review.
