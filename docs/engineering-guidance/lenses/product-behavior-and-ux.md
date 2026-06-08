# Product Behavior And UX

## What This Lens Protects

This lens protects user-visible honesty, continuity, attention, and product trust. In Isagi, product behavior is engineering behavior whenever it affects what the user sees, resumes, trusts, or acts on.

## Review Questions

- Does the change preserve the idea that a worktree is a resumable room?
- Does the product honestly show what was restored, recreated, missing, failed, or degraded?
- Are missing files, artifacts, agent sessions, surfaces, or commands visible rather than silently removed?
- Does attention state reflect real user action needed, or could it create false confidence/noise?
- Does the UI help the user understand what happened without exposing implementation noise?
- Are errors and empty states useful for the user's next action?
- Does the change keep the work surface as the hero instead of letting chrome compete with it?
- Does behavior remain keyboard-reachable for primary workbench actions where relevant?
- Is copy accurate and useful for the user's next action or for support, regardless of styling?

Visual and voice adherence to Isagi's design language is reviewed by `design-fidelity-and-voice.md`. This lens owns whether copy is honest and useful; that lens owns whether it is on-voice.

## Isagi-Specific Notes

- Worktrees are first-class continuity units. Tasks remain user-owned and should not become a core primitive by accident.
- The main/root checkout should behave as a first-class worktree, except where root-specific behavior matters.
- A restored missing artifact should show a missing state instead of silently closing the surface.
- Waiting-for-user state is part of momentum, not decoration.

## Severity Mapping

### Blocker

- The UI presents failed, partial, or uncertain restoration as successful.
- User-visible behavior contradicts the product model of projects, worktrees, environments, commands, surfaces, or attention signals.
- Attention state is materially misleading for whether the user is needed.
- A user-impacting failure is hidden, swallowed, or impossible to act on.
- The change introduces a first-class product concept that conflicts with existing durable docs without an explicit product decision.

### Concern

- The behavior is technically correct but unclear enough to create support burden.
- A missing/degraded state is visible but does not help the user decide what to do next.
- UI copy is accurate but too vague for debugging or support.
- Product behavior handles one case well but creates inconsistent expectations across similar surfaces.
- The work surface loses focus to navigation, chrome, or status UI without a clear reason.

### Nit

- Copy could state the user-facing situation more clearly.
- A status label could better match the actual state.
