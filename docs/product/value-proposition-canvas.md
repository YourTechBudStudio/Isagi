# Value Proposition Canvas (source of truth)

**Codename:** Isagi  
**Legacy product name:** Spark System  
**Last updated:** 2026-03-11

This canvas is the **strategic framing source of truth**.

For implementation scope and MVP build decisions, `docs/product/mvp-scope.md` wins.

**MVP constraint:** In Phase 1, the release focuses on projects, collections, tasks, sessions, and worktree controls. Spark triage is deferred to Phase 2, and quick-capture surfaces are strategic but not part of the strict first release path. Any "development" described below should be interpreted as _creating or shaping tasks and enabling warm-start sessions_, not auto-generating outputs.

---

# Value Proposition Canvas: Isagi

## Customer Profile

### Jobs to be Done

| Job                                                                                                     | Type       | Priority |
| ------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| Progress coding/product tasks consistently with low startup friction                                    | Core       | Highest  |
| Develop raw sparks into executable tasks when backlog help is needed                                    | Core       | High     |
| Run multiple task threads in parallel without repo/context collisions                                   | Core       | High     |
| Maintain a healthy actionable queue so I always know what to do next                                    | Core       | High     |
| Capture ideas quickly when they occur                                                                   | Supporting | High     |
| Preserve internal documentation/resources without coupling them to public/open-source code repositories | Supporting | Medium   |
| Track progress across projects/tasks                                                                    | Supporting | Low      |

### Pains

| Pain                                                                                                                 | Severity |
| -------------------------------------------------------------------------------------------------------------------- | -------- |
| **Activation energy to start** — even though the work is fun, initiating feels like pushing a boulder uphill         | Severe   |
| **Context loading friction** — priming AI with context, remembering where I left off, explaining what I'm working on | Severe   |
| **Backlog fragility** — no healthy queue when it's time to execute                                                   | Severe   |
| **Direction friction** — uncertainty about what to do next                                                           | Severe   |
| **Every conversation starts cold** — no continuity between sessions                                                  | Moderate |
| **Sequential execution drag** — parallelizable work gets forced into serial effort                                   | Moderate |
| **Capture friction** — confusion about where to put ideas                                                            | Moderate |
| **Ideas decay** — lose context, forget about them, laundry list graveyard                                            | Moderate |
| **High setup overhead for small tasks** — context/briefing cost exceeds task size                                    | Moderate |
| **Context scattered** — docs and decisions are spread across tools                                                   | Low      |

### Gains

| Gain                                                                                                                    | Importance |
| ----------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Warm starts** — when I sit down to work, context is loaded and the boulder is already rolling                         | Critical   |
| **Co-ownership** — building with AI while keeping executive control                                                     | Critical   |
| **Context continuity** — I never have to restate history to continue                                                    | Critical   |
| **Queue visibility** — I can quickly see what is waiting on me and what to run next                                     | High       |
| **Getting to the fun parts faster** — less setup, more execution                                                        | High       |
| **Parallelized execution** — multiple task threads can run safely in parallel                                           | High       |
| **Desktop-first focus for deep work** — one primary surface for coding/repo-heavy sessions                              | Medium     |
| **Cheap rule evolution** — behavior evolves through configurable rules/templates instead of hardcoded workflow branches | Medium     |

---

## Value Map

### Products & Features

| Feature                            | Description                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Quick capture (future phase)**   | A later low-friction capture surface for sparks or ideas outside the strict Phase 1 release path.                              |
| **Smart triager (Phase 2)**        | Clarifies sparks and proposes project/task follow-on work when backlog help is needed.                                         |
| **Resumable sessions**             | Each task opens a session surface that can be paused and resumed.                                                              |
| **Scratch sessions**               | A low-overhead project-scoped exploration lane for quick questions or repo inspection without creating backlog noise.          |
| **Context continuity engine**      | Every session starts pre-loaded with relevant context and a concise "where we left off" state.                                 |
| **Command-driven execution**       | Session start behavior comes from lightweight defaults and git mode rules, not hardcoded task types.                           |
| **Managed worktrees**              | Worktree creation becomes a fast optional workflow for isolated coding threads.                                                |
| **First-principles collaboration** | Agents challenge assumptions, propose alternatives, and keep user as decision-maker.                                           |
| **Generic primitives**             | A small universal model (project/collection/task/session, with spark deferred) supports many workflows without bespoke models. |
| **Integration-ready foundation**   | External integrations can be layered later without changing the core continuity model.                                         |

### Pain Relievers

| Pain                           | How Product Addresses It                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Activation energy to start     | Agent primes YOU: "Last time we established X, you wanted Y, where do you want to pick up?" Boulder already rolling.         |
| Context loading friction       | Context continuity engine handles all priming. You never explain what you're working on.                                     |
| Running out of next actions    | Task lists keep actionable work visible in Phase 1; later spark tools may help feed backlog.                                 |
| "What should I do next?"       | Warm-start sessions and task context reduce decision friction at start time.                                                 |
| Every conversation starts cold | Resumable chats with full context. Agent summarizes state when you return.                                                   |
| Sequential execution drag      | Task-linked sessions plus optional managed worktrees support safer parallel progress.                                        |
| High setup overhead            | Scratch sessions keep project-scoped questions and lightweight exploration cheap when a full tracked task would be overkill. |
| Capture friction               | A future quick-capture surface can avoid early routing decisions once capture returns to the active product.                 |
| Ideas decay                    | Phase 2 spark tools can later convert loose ideas into follow-on work when needed.                                           |
| Context scattered              | Project-scoped tasks and session history keep decisions and outputs discoverable.                                            |

### Gain Creators

| Gain                        | How Product Creates It                                                         |
| --------------------------- | ------------------------------------------------------------------------------ |
| Warm starts                 | Every task/session opens with context assembled and clear next decision points |
| Co-ownership                | Interactive checkpoints keep user in control while agents accelerate execution |
| Context continuity          | Project context + task history + session history preserve continuity           |
| Queue security              | Home/focus surfaces show what is blocked, active, and ready                    |
| Getting to fun parts faster | Setup and recall overhead are reduced by defaults and resumable sessions       |
| Desktop-first deep work     | One primary execution surface reduces context fragmentation                    |
| Cheap rule evolution        | Rules/templates allow iterative behavior tuning without redesigning the core   |

---

## Core Value Proposition Statement

> **The system eliminates context loading as a barrier to creative work.**
>
> In the active MVP, agent conversations should feel pre-loaded with: the relevant task, project context, prior decisions, execution context, and a summary that primes you on where things stand. Future spark tooling may later feed into the same continuity model.
>
> You never start from zero. You never explain what you're working on. You never hunt for documents. You just continue.
>
> **The boulder is already rolling. You just keep pushing.**

---

## Key Insight

The bottleneck isn't time, organization, or even enjoyment - the work is fun once you're in it. The bottleneck is **activation energy to start**, especially when tired from a full-time job.

The difference between:

- "I need to open Notion, start a new doc, pull up my rubric, prime the AI, remember what I was doing..."
- "I'll just check the app... oh, there's a task session waiting... let me respond to this one question..."

...is the difference between not starting and accidentally doing 2 hours of productive work.

---

## Design Principles

1. **Warm starts over cold starts** - Every interaction should feel like continuing, not beginning
2. **Prime the human too** - Agent summarizes state so you remember where you left off
3. **Co-ownership, not delegation** - You make executive calls; agents help you discover breadth
4. **Fun parts fast** - Automate the unfun (context loading, setup overhead); preserve the fun (creative decisions, execution)
5. **Desktop-first MVP** - Ship one strong deep-work surface first; add mobile later when core behavior is stable
6. **Sparks can die** - Active work matters; graveyard of unpromoted sparks is acceptable
7. **Context compounds** - Project context and session outputs remain available to downstream work
