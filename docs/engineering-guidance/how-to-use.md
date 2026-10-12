# How To Use This Guidance

Use this guidance as a question set while coding and reviewing. It should catch drift from Isagi's product model, architecture boundaries, supportability goals and human-readable code.

## For Coding Agents

Before editing, pick the relevant lenses and keep their questions nearby while you work instead of treating them as a final checklist.

Some lenses meet around stateful runtime/client work. Keep their jobs distinct: `boundaries-and-contracts.md` decides who owns a fact or API boundary, `state-flow-and-operational-cost.md` decides whether a transition has the right cause, scope and cost, and `runtime-behavior-and-diagnostics.md` reviews lifecycle, failure, cancellation and diagnosability once operational work exists. When a change touches user-facing UI or copy, load the `design-system` skill.

Prefer the smallest correct change that keeps the product model intact and the code easy to follow. For Effect code, follow ADR 0011.

When the change is complete, report what changed, what was verified, and any known risk or follow-up. Do not claim more confidence than the evidence supports.

## For Review Agents

Review the change against each relevant lens; the lenses are equal priority, so do not skip one because it usually finds less.

Prefer findings that explain consequence: what could break, drift, become hard to debug, or become hard to change. Use the lens's own severity calibration. When two severities seem plausible, choose the lower one unless the consequence is concrete and material. Report a finding under the lens that best describes its primary failure instead of duplicating it.

Useful review output is concise: findings ordered by severity, file and line references, why each matters for Isagi, the evidence used, and what was not verified. Do not restate the guidance.

## Severity Ladder

Each lens calibrates these levels for its own concerns.

- **Blocker** - material divergence from the guidance. Fix before returning the change, then re-review.
- **Concern** - a design, runtime, maintainability, supportability or product gap with real consequence. Fix it when the fix is clear; bring it to the user when it needs a tradeoff or conflicts with their stated direction. Re-review only if the fix is substantial.
- **Nit** - a marginal optional improvement. Apply only if trivial and safe; never a reason to re-review.

Never silently dismiss a Blocker or Concern; dismissing either needs the user's explicit acknowledgement.

## Architectural Reflection

Separately from findings, a review may return an `Architectural Reflection`: a proposal that a simpler mental model or a different solution shape would serve the goal better. It sits outside the ladder and never triggers a re-review. Weigh it as a decision, not a patch:

- **In scope and clearly aligned with the plan** - you may adopt it, as a deliberate choice rather than an autopilot edit.
- **Beyond the change's scope, structural, or in tension with the plan** - stop and offer the user two paths: re-architect now, or ship the current change and defer the restructuring. Where a deferred restructuring lands is the user's call.

You own plan and intent; the reviewer only estimates technical blast radius. Never silently fold a large or scope-expanding re-architecture into the change.
