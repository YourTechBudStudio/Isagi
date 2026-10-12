# Product, UX And Design

## What This Lens Protects

User-visible honesty, continuity, attention and trust, and whether Isagi looks and sounds unmistakably like itself instead of drifting toward generic templates. In Isagi, product behavior is engineering behavior whenever it affects what the user sees, resumes, trusts or acts on.

The [`design-system` skill](../../../.agents/skills/design-system/SKILL.md) is the single source of truth for visual style and voice. This lens does not restate it: when a change touches a user-facing surface, load the skill and review against it. This lens adds the review questions and the severity ladder.

## Scope

- In scope: shipped user-facing UI, marketing surfaces, and user-facing copy, including the web-owned error and status copy that error codes map to.
- Out of scope for design fidelity: internal engineering docs, and dev-only, mock and scaffolding surfaces.
- Whether a failure carries a mappable code, and whether a runtime string leaks through as copy, belong to `boundaries-and-contracts.md`.

## Review Questions

Behavior:

- Does the change keep a worktree a resumable room?
- Does the product honestly show what was restored, recreated, missing, failed or degraded? Are missing files, artifacts, sessions, surfaces or commands visible rather than silently removed?
- Does attention state reflect real user action needed, without false confidence or noise?
- Are errors and empty states accurate and useful for the user's next action, without implementation noise?
- Does the work surface stay the hero, instead of chrome competing with it?
- Are primary workbench actions keyboard-reachable where relevant?

Design and voice:

- Does the surface read as Isagi, or could it have shipped from any template?
- Do accents earn their use? Is red reserved for genuine destruction or error?
- Is type on the house families with decisive hierarchy? Does motion use the one expo-out curve with duration matched to deliberateness?
- Does the layout commit to generous space or controlled density, rather than the timid middle?
- Is copy plain, deadpan and conversational, free of marketing-speak and sparkle? Does humour stay in its allowed places (empty states, 404s, footers, tip bars, fixable errors)?
- Is sentence-level prose in the web copy layer, where it can be reviewed in one place?
- Does the change reuse an existing visual or copy pattern where one fits?

## Isagi-Specific Notes

- Worktrees are first-class continuity units. Tasks stay user-owned and must not become a core primitive by accident. The main checkout behaves as a first-class worktree except where root-specific behavior matters.
- A restored missing artifact shows a missing state instead of silently closing the surface. Waiting-for-user state is part of momentum, not decoration.
- Copy findings split by what is wrong: inaccurate or too vague to act on is a behavior finding; off-voice, marketing-speak or humour in the wrong place is a voice finding.
- The skill's anti-pattern list is a hard ban; a listed anti-pattern on an in-scope surface is a real finding, not a nit.
- Isagi's default is personality. A harmless string (no accuracy, honesty, clarity or placement consequence) that leans vivid, plain and a little dry is correct, not a finding. That relaxation never reaches destructive confirmations, validation errors, agent status lines, primary CTAs or constantly seen chrome. Consequential but non-destructive trust prompts may still carry vivid-plain voice.

## Severity Mapping

### Blocker

- Failed, partial or uncertain restoration is presented as success.
- Behavior contradicts the product model of projects, worktrees, environments, commands, surfaces or attention signals, or adds a first-class concept that conflicts with durable docs without an explicit product decision.
- Attention state is materially misleading about whether the user is needed.
- A user-impacting failure is hidden, swallowed or impossible to act on.
- A hard-ban anti-pattern ships on an in-scope surface (a banned or default font stack, sparkle on an AI surface, a stock gradient or flat hero, a hard drop shadow as default elevation).
- Humour appears in a forbidden place, red marks something that is not destruction or error, or a string uses marketing-speak or banned vocabulary.

### Concern

- Behavior is correct but unclear enough to create support burden, or a degraded state is visible but does not help the user decide what to do.
- Copy is accurate but too vague for debugging or support, or drifts toward generic, hedging or template register. (Drift toward more Isagi personality on a harmless string is not a finding.)
- Similar surfaces now set inconsistent expectations, or a new visual or copy pattern is invented where a house pattern fits.
- The work surface loses focus to chrome without a clear reason.
- Visual drift short of a hard ban: accent overload, timid-middle spacing, motion off the curve, a spinner on slow work.
- Sentence-level copy is written inline instead of in the copy layer, or copy modules start owning JSX or layout.

### Nit

- Copy or a status label could state the situation more clearly.
- Minor visual polish: a halo, gradient, shadow or letter-spacing could be tuned.
- An empty or edge state could better match Isagi's warmth.
- A short local label could move to the copy layer, with low reviewability risk.
