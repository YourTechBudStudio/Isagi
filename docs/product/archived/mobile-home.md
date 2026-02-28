# Mobile home screen (archived)

**Status:** Archived for current MVP phase (desktop-first).  
**Last updated:** 2026-02-10

This document is preserved for future reactivation. It is not part of the active MVP scope.

---

# Mobile home screen

This document defines the **mobile app home screen** (landing page) for Isagi.

## One-liner

The mobile home screen answers: **"What can I do next, in under 2 minutes, to move things forward?"**

## Primary job

- Reduce activation energy by surfacing a small, high-leverage set of next steps.
- Make triage/spark-development feel like a continuing conversation, not a blank slate.
- Keep the phone experience **code-free** while still supporting full agent discussions.

## Non-goals

- Doing coding work on mobile (writing/reviewing code, PR work, repo workflows).
- Becoming a "daily planner" feed with infinite scroll.
- Replacing quick capture: widget remains the primary capture path.

## Surfaces & ordering (top-to-bottom)

1. **Resume (mobile-only)**
2. **Focus Queue** (includes "waiting on you" items)
3. **Spark development / triage** (Triager agent chat)
4. **Backlog health** (glanceable indicators)

## Focus Queue rules

### Item types (UI labels)

- **Waiting on you** - an agent/session is blocked and needs an answer/decision.
- **Suggested next** - a phone-appropriate action that moves a work item forward.

Note: Internally, "waiting on you" is typically backed by `GateRequest`. The UI should not use "gate" language.

### Sorting

1. "Waiting on you" first
2. then "Suggested next"

(Exact ranking heuristics are still TBD.)

### Anti-overwhelm cap

- Show **3** items by default.
- Provide a clear **Show all** affordance.

## Resume semantics

- **Device-scoped:** mobile resumes what you were doing **on mobile**, not what you last did on desktop.
- **Work-item scoped:** resuming means opening the **agent conversation** attached to a work item.

## Spark development / triage semantics

- The Triager is a **full agent conversation** for developing a spark (expanding it, asking questions, and proposing next work).
- Each captured spark has an associated work item (conceptually: "develop this spark") whose primary UI is the Triager chat.
- Triager conversations may also propose **derived sparks** (follow-on sparks) that you can keep or discard.

## Capture entry points

- Primary: **Android home screen widget** -> lightweight capture overlay.
- Secondary: a **global in-app Capture button (FAB)** available from any screen.

## Backlog health indicators

Backlog health is a quick answer to: **"Am I going to run dry?"**

On mobile home, keep this glanceable (e.g., a compact status + a few counts).

Initial candidate metrics (TBD):

- storylines ready
- drafts ready (by workstream)
- sparks awaiting development
- "waiting on you" count

## Voice & copy

UI copy should be clear first, but default to a witty/playful tone with light nerd humor. The app can speak as an AI with a comedic "taking over the world" bit, without being threatening or reducing usability.

## What's undecided

- The exact backlog health metrics shown on mobile first.
- The exact Focus Queue ranking heuristic (age vs priority vs effort-to-answer).
- Whether "Resume" is hidden when empty vs shown as an empty state.
