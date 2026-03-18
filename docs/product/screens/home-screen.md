# Home Screen (MVP)

**Last updated:** 2026-03-17

## One-liner

The desktop Home screen answers: **"What can I resume right now with the least friction?"**

## Primary job

- Act as a minimal global orientation surface.
- Help the user jump back into active work quickly.
- Keep attention on live execution threads rather than backlog management.

## Non-goals

- Becoming a project-management dashboard.
- Becoming a daily planner or priority-ranking system.
- Replacing project detail as the place to browse and manage tasks deliberately.
- Reintroducing Phase 2 spark inbox or triage behavior into the active MVP Home surface.

## Global posture

- Home is **global**, not project-scoped.
- Home is **session-led**, not task-led.
- Home is optimized for fast re-entry, not broad system visibility.
- The command palette remains the primary way to jump to a specific project when the user wants deliberate navigation.

## Information hierarchy

### Resume now

- The primary hero surface is the **most recent resumable session**.
- This is the dominant action on Home.
- The goal is to let the user continue momentum without first scanning projects or task lists.
- The hero may be a task session, a scratch session, or a shaping session.
- Scratch sessions should carry a strong visible scratch indicator wherever they appear.
- Shaping sessions should carry an equally visible shaping indicator wherever they appear.

### Other open sessions

- Additional open sessions appear as compact secondary options.
- They should be shown in a simple vertical list rather than a dense dashboard treatment.
- Each item should stay lightweight and scan-friendly.
- Helpful metadata may include the project name, priority, and last active time.
- Scratch sessions should appear in the same list rather than a separate subsection, while remaining visibly marked as scratch.
- Shaping sessions should also appear in that same list rather than a dedicated shaping subsection, while remaining visibly marked as shaping.

### No-resume fallback

- If there are no resumable sessions, Home may show a lightweight set of candidate tasks.
- This fallback exists to help the user restart momentum, not to become a full task browser.
- Deliberate task selection still belongs in project-specific task surfaces and the command palette rather than Home itself.

## Ranking and selection rules

- The Home hero is the **most recent resumable session**.
- Additional open sessions are secondary and should remain visually subordinate to the hero.
- Scratch sessions follow the same recency-led model rather than being automatically down-ranked.
- Shaping sessions also follow that same recency-led model unless later heuristics prove a need to treat them differently.
- Home may show priority as supporting metadata, but it should not turn into a global planning or ranking surface.
- Manual signals such as closed sessions, done-bucket task completion, or technical error states are stronger than heuristic guesses about relevance.

## Empty states

### No projects

- Primary CTA: **Add your first project**.
- The empty state should explain that projects are existing local git repos registered in Isagi.
- `Add your first project` should launch the command-palette-backed project registration wizard described in `docs/product/screens/project-registration-flow.md`.

### Projects exist, but no tasks or sessions yet

- Primary CTA: **Start a session**.
- Secondary CTA: **Create task**.
- `Start a session` here should route through the command palette with the start-session command preselected.
- Project selection is required before the session starts.
- That command-palette flow may branch into either:
  - a task-backed ad-hoc session that auto-creates a visible task from the first user message
  - a scratch session that stays project-scoped and does not create a task
- That Home entry is for general worker sessions only and does not start shaping sessions.
- New shaping work still begins from project context through **Shape what's next**.
- `Create task` should also route through explicit project selection rather than assuming implicit project context on Home.
- This keeps startup aligned with the MVP's low-friction, session-first posture.

### Tasks exist, but no resumable sessions

- Show lightweight candidate tasks.
- Keep the UI minimal and action-oriented.
- Pair the task fallback with a clear route to command palette or project-specific task surfaces when the user wants to choose more deliberately.

## Relationship to sidebar and command palette

- The sidebar already provides persistent visibility into active and idle sessions.
- Those session lists may include task sessions, scratch sessions, and shaping sessions.
- Home should complement that persistent context rather than duplicate it with a large dashboard.
- The command palette remains the fastest way to open a specific project or trigger actions from anywhere.
- Global session-start actions from Home should use the command palette rather than guessing project context implicitly.
- The command palette is also the primary place where the user chooses between a task-backed ad-hoc session and a scratch session when starting general worker work from Home.
- New shaping work still starts from project context rather than Home, but resumable shaping sessions should remain visible on Home once they exist.

## Out of scope / future phase notes

- Global spark inbox and spark triage remain out of scope for Phase 1 Home.
- Rich daily planning, pinned-project ranking, and broader backlog curation remain future-phase concerns.
- A future version may refine candidate-task heuristics, but the MVP should prefer clarity and low friction over clever ranking.
