# Reviewability And Verification

## What This Lens Protects

This lens protects trust in completed work. Changes should be easy for humans and review agents to understand, verify, and maintain.

## Review Questions

- Does the change explain its own shape through clear module boundaries, names, and flow?
- Can a reviewer identify the important behavior without reading unrelated scaffolding?
- Does verification match the risk of the change?
- Were meaningful degraded or failure paths checked when runtime behavior changed?
- Are contracts, runtime behavior, and user-visible states verified at the right level?
- Does the final summary distinguish what was verified from what was not?
- Are new dependencies justified by the problem they solve?
- Does the change avoid broad churn unrelated to the goal?
- Are generated/build artifacts excluded unless they are intentionally part of the change?
- Are known limitations or tradeoffs surfaced instead of hidden?

## Isagi-Specific Notes

- Root `pnpm check` is the default verification command after code changes.
- Package-level checks can be useful while iterating, but final confidence should match the change scope.
- Do not start long-running dev servers as verification.
- Runtime lifecycle changes need stronger evidence than static UI copy changes.
- Completed work should be easy for a human maintainer to trust, especially when produced by an agent.

## Severity Mapping

### Blocker

- The change cannot be reasonably reviewed for correctness because behavior ownership or flow is materially obscured.
- A high-risk runtime, contract, persistence, or process change has no meaningful verification.
- The change introduces broad unrelated churn that hides the actual behavior change.
- A new dependency materially changes runtime, packaging, security, or maintenance risk without justification.

### Concern

- Working code is hard to review or explain, but the main behavior can still be assessed.
- Verification does not match the risk of the change.
- Failure paths or degraded states were not checked where they are likely to matter.
- The final summary overstates confidence or omits important residual risk.
- A dependency is probably acceptable but its role or footprint is not explained.

### Nit

- A summary could be clearer.
- A low-risk manual check could be mentioned.
- A small test name, assertion, or fixture could be easier to read.
- Minor unrelated cleanup should be split out next time.
