# Planning Artifacts

**Last updated:** 2026-04-28

## One-liner

Durable planning state lives as Git-backed Markdown artifacts under `.isagi/`.

## Artifact posture

- `.isagi/` belongs in Git by default.
- Files are the source of truth for durable planning state.
- The backend may index or project these files later, but indexing is optional and rebuildable.
- Runtime/session state is backend-owned and is not rebuilt from `.isagi/` files.
- Artifacts should stay simple enough for agents to create and humans to review in normal Git workflows.

## Recommended layout

Use this as a convention seed, not a final filesystem spec:

```txt
.isagi/
  milestones/
  tasks/
  sparks/
  config/
```

## Tiny frontmatter core

Artifacts should have a tiny stable frontmatter core so agents can link and update them without needing a heavy schema.

Seed fields:

- `id` - stable, human-readable slug
- `type` - artifact kind
- `title` - human-readable title
- `status` - when the artifact participates in workflow status

Task status should live in task artifact frontmatter so status can be rebuilt from project files.

Avoid finalizing detailed schemas until implementation work starts.

## Milestones

A milestone is the primary continuation and planning unit.

A good milestone is:

- **coherent** - it points in one meaningful direction
- **value-delivering** - completing it creates visible progress for some stakeholder
- **finishable** - it is large enough to matter and small enough to complete with confidence
- **direction-setting** - it gives downstream tasks a clear center of gravity
- **momentum-creating** - it should unlock easier or more valuable follow-up work
- **explainable** - the user can say why it matters in plain language
- **bounded** - it has some sense of what belongs inside or outside it
- **outcome-reviewable** - completion should not feel arbitrary

Milestone artifacts should preserve enough direction to support later shaping without forcing a fixed field list.

Milestones group work, but they do not redefine execution context. In the MVP, execution still starts from the project repo or selected execution root.

## Tasks

A task is a reviewable agentic work chunk that is concrete enough to execute without another discovery session.

Tasks usually deliver meaningful progress toward a milestone after Shaping, but direct project-level tasks are allowed for ad hoc or small work.

A good task is:

- bigger than a micro-todo
- smaller than an ambiguous mini-project
- focused on one dominant purpose
- understandable by the human reviewer
- suitable for one coherent agentic execution thread or a small related cluster
- clearly connected to the milestone it advances, when milestone-linked
- shaped enough that the user can roughly visualize the work

Tasks remain execution-agnostic. Branches, worktrees, and sessions are execution choices, not task identity.

No subtasks are planned for v0.

## Sparks

A spark is something worth remembering that may or may not influence future discovery.

Sparks are not proto-tasks and should not force a triage ceremony. They are one context source Discovery may use when deciding what milestone should come next.

Project-scoped sparks live under the project `.isagi/` space. Unscoped personal sparks may exist outside project files; when one becomes relevant to a project, create or copy a project-scoped spark instead of moving the original.

## Config

`.isagi/config/` holds Git-backed project configuration such as statuses and future prompt/template configuration.

Exact config files are intentionally deferred. The important direction is that project planning/config state should be rebuildable from project files where practical.

## Discovery and shaping prompts

Discovery and Shaping are prompt-template modes over the same core brainstorming capability.

Discovery asks: **What milestone should this project continue toward next?**

Discovery should:

- ground itself in project context
- use sparks, current milestones, existing tasks, and relevant files as context
- propose milestone direction in chat first
- avoid writing milestone files until the user confirms

Shaping asks: **What task chunks make this milestone executable?**

Shaping should:

- use the chosen milestone as the center of gravity
- apply the agent-era task qualities above
- propose task chunks in chat first
- avoid writing task files until the user confirms

UI may adapt side panels for Discovery or Shaping, but the model does not require separate agent types.
