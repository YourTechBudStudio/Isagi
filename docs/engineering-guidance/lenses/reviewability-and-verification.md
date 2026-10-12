# Reviewability And Verification

## What This Lens Protects

Trust in completed work. Changes should be easy for humans and review agents to understand, verify and maintain, especially when an agent produced them.

## Review Questions

- Does the change explain its own shape through clear boundaries, names and flow, without unrelated scaffolding in the way?
- Does verification match the risk in both directions: enough evidence for risky behavior, and no brittle assertions pinning cosmetic output that churn on rewording without catching defects?
- Were degraded and failure paths checked when runtime behavior changed?
- When API contracts changed, were success and representative error paths checked across contract, runtime and client?
- Are contracts, runtime behavior and user-visible states verified at the right level?
- Does the summary separate what was verified from what was not, and surface known limitations and tradeoffs?
- Is each new dependency justified by the problem it solves?
- Does the change avoid broad churn unrelated to its goal, and leave generated or build artifacts out unless they are intended?

## Isagi-Specific Notes

- Runtime lifecycle and API boundary changes need stronger evidence than copy changes.
- Prefer behavioral or exhaustiveness checks over literal-string equality for copy and thin framework round-trips.
- Package-level checks help while iterating; final confidence should match the change's scope.

## Severity Mapping

### Blocker

- Correctness cannot reasonably be reviewed because behavior ownership or flow is materially obscured.
- A high-risk runtime, API contract, persistence or process change has no meaningful verification.
- Broad unrelated churn hides the actual behavior change.
- A new dependency materially changes runtime, packaging, security or maintenance risk without justification.

### Concern

- Working code is hard to review or explain, though the main behavior can still be assessed.
- Verification does not match the risk, or likely failure paths, degraded states or representative API errors went unchecked.
- The summary overstates confidence or omits important residual risk.
- A dependency is probably fine but its role or footprint is unexplained.

### Nit

- A summary, test name, assertion or fixture could be clearer.
- A low-risk manual check could be mentioned.
- A brittle assertion pins cosmetic output where a behavioral check would be sturdier.
- Minor unrelated cleanup should be split out next time.
