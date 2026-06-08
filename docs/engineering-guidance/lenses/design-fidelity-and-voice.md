# Design Fidelity And Voice

## What This Lens Protects

This lens protects whether Isagi looks and sounds unmistakably like itself instead of drifting toward generic AI-slop. It reviews two halves together: **visual fidelity** (palette, typography, motion, spatial composition, atmosphere) and **voice fidelity** (register, tone, copy patterns, humour placement).

The [`design-system` skill](../../../.agents/skills/design-system/SKILL.md) is the single source of truth for the house style. This lens does not restate it. When a change touches a surface in scope, load the skill and review the change against it; this doc adds only the severity ladder the skill lacks and the scope boundary for review.

## What Is In Scope

- Shipped user-facing UI.
- Marketing surfaces.
- User-facing error and status **messages** — the human-readable strings the UI renders as-is, including messages that originate in the runtime or API. The error contract (codes, structured fields, wire shape) stays with `boundaries-and-contracts.md`; this lens reviews only the message text the end user reads.

## What Is Out Of Scope

- Repo and package docs meant for internal/engineering use.
- Dev-only, mock, and scaffolding surfaces. The reviewer is usually not run on these, and they exist to exercise behavior, not to be production-grade.

## Review Questions

- Does the surface read as Isagi, or could it have shipped from any AI-generated template?
- Visual: do accents earn their use, or does the surface reach for too many at once? Is red reserved for genuine destruction or error?
- Visual: is the typography on the house families, with decisive hierarchy — not a banned or default font stack?
- Visual: does motion use the single expo-out curve with duration matched to deliberateness, instead of springs, overshoot, or spinners on slow work?
- Visual: does the layout commit to either generous space or controlled density rather than the timid middle? Does the canvas keep its atmospheric depth and layered (not hard) shadows?
- Voice: is copy deadpan, plain, and conversational — free of marketing-speak ("supercharge", "seamless", "delightful") and sparkle?
- Voice: does humour stay in its allowed surfaces (empty states, 404s, footers, tip bars, fixable-error messages) and stay out of CTAs, working chrome, agent status lines, destructive confirmations, and validation errors?
- Voice: do user-facing error and status messages match the dry, informative register even when they come from the runtime?
- Does the change repeat an existing pattern where one fits, rather than inventing a new visual or copy treatment?

## Isagi-Specific Notes

- The skill's anti-pattern list is a hard ban, not a preference. Treat a listed anti-pattern on an in-scope surface as a real finding, not a nit.
- Voice is the most identifiable thing about Isagi. Wrong register on a user-facing string is a fidelity failure even when the string is accurate.
- Isagi's default is personality, not neutrality. When a user-facing string is harmless — no accuracy, honesty, clarity, or wrong-location consequence — leaning into Isagi's voice (vivid, plain, a little dry) is correct and is **not** a finding. Do not flag copy merely for being more colourful than a flatter, neutral alternative; "name the thing plainly" includes naming the real stakes vividly.
- The relaxation above is tied to *harmless*. It does not extend to the forbidden locations below (destructive confirmations, validation errors, agent status lines, primary CTAs, constantly-seen chrome), where seriousness or restraint is the point. Trust/approval prompts that are consequential but not destructive (e.g. approving project setup hooks) may carry vivid-plain voice; reserve the strict bar for genuinely destructive or irreversible confirmations.
- This lens and `product-behavior-and-ux.md` split copy by what is wrong with it: copy that is inaccurate or too vague to support belongs to that lens; copy that is off-voice, marketing-speak, or cute in the wrong place belongs here.

## Severity Mapping

### Blocker

- A hard-ban anti-pattern ships on an in-scope touchpoint: a banned or default font stack as primary type, sparkle/✨ on an AI surface, a stock gradient or flat-color hero, a hard drop shadow as the default elevation.
- Humour appears in a forbidden location: a primary CTA, a destructive confirmation, a validation error, or chrome the user sees constantly.
- Red is used for something that is not genuine destruction or error.
- A user-facing string reads as marketing-speak or uses banned vocabulary.

### Concern

- Visual drift that is not a hard ban: accent overload, the timid-middle spacing default, motion off the expo-out curve, or a spinner on an operation that takes real time.
- A new visual or copy pattern is invented where an existing house pattern fits.
- Copy register drifts toward generic or marketing-flavoured — reads like a template, hedges, or trades plainness for polish. (Drift toward *more* Isagi personality on a harmless string is not a finding; see Isagi-Specific Notes.)

### Nit

- Minor visual polish: a halo, gradient, or shadow that could be tuned; overline letter-spacing.
- An empty or edge state that is fine but could better match Isagi's warmth.
