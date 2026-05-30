# How To Use This Guidance

Use this guidance as a question set during coding and review. It should help catch drift from Isagi's product model, architecture boundaries, supportability goals, and human-readable code standards.

## For Coding Agents

Before editing, identify which lenses are relevant to the change. During implementation, keep the relevant lens questions nearby instead of treating them as a final checklist.

Prefer the smallest correct change that preserves the product model and keeps the code easy to follow. If a cleaner internal interface requires migrating callers, migrate them rather than adding compatibility shims, unless a real external boundary depends on the old behavior.

When the change is complete, report what changed, what was verified, and any known risk or follow-up. Do not claim confidence that the evidence does not support.

## For Review Agents

Review the change against each relevant lens. The lenses are equal priority; do not skip a lens just because it often produces fewer findings.

Prefer findings that explain consequence. A good finding says what could break, drift, become hard to debug, or become hard to change.

Use the lens-specific severity mapping. When two severities seem plausible, choose the lower severity unless the consequence is concrete and material.

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
