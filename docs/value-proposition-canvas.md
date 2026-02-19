# Value Proposition Canvas (source of truth)

**Codename:** Isagi  
**Product name:** Spark System  
**Last updated:** 2026-02-07

This canvas is the **strategic framing source of truth**.

For implementation scope and MVP build decisions, `docs/mvp-scope.md` wins.

**MVP constraint:** In Phase 1, the Triager is **propose-only** (see [MVP scope](./mvp-scope.md)). Any “development” described below should be interpreted as _proposing work items and enabling warm-start sessions_, not auto-generating artifacts.

---

# Value Proposition Canvas: Spark System

## Customer Profile

### Jobs to be Done

| Job                                                                                                 | Type       | Priority |
| --------------------------------------------------------------------------------------------------- | ---------- | -------- |
| Progress coding/product tasks consistently with low startup friction                                | Core       | Highest  |
| Develop raw sparks into executable tasks and durable notes                                          | Core       | High     |
| Run multiple task threads in parallel without repo/context collisions                               | Core       | High     |
| Maintain a healthy actionable queue so I always know what to do next                                | Core       | High     |
| Capture ideas quickly when they occur                                                               | Supporting | High     |
| Preserve internal documentation/notes without coupling them to public/open-source code repositories | Supporting | Medium   |
| Track progress across areas/projects/tasks                                                          | Supporting | Low      |

### Pains

| Pain                                                                                                                 | Severity |
| -------------------------------------------------------------------------------------------------------------------- | -------- |
| **Activation energy to start** — even though the work is fun, initiating feels like pushing a boulder uphill         | Severe   |
| **Context loading friction** — priming AI with context, remembering where I left off, explaining what I'm working on | Severe   |
| **Running dry on social media** — no backlog when I need to post, even though I have ideas all the time              | Severe   |
| **Research friction** — specifically figuring out _what_ to research                                                 | Severe   |
| **Every conversation starts cold** — no continuity between sessions                                                  | Moderate |
| **Manual rubric execution is sequential and tedious** — storyline alone takes 6 hours across 2 days                  | Moderate |
| **Capture friction** — confusion about where to put ideas                                                            | Moderate |
| **Ideas decay** — lose context, forget about them, laundry list graveyard                                            | Moderate |
| **Small/micro rubrics aren't worth creating manually**                                                               | Moderate |
| **Context scattered** — have to copy-paste artifacts to share with team                                              | Low      |

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

| Feature                            | Description                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Quick capture**                  | Frictionless spark entry from desktop (mobile capture can be layered later).                                   |
| **Smart triager**                  | Clarifies sparks and proposes area/project/task creation with reasoning and questions.                         |
| **Resumable chat agents**          | Each task opens a chat/session surface. Sessions persist and can be resumed.                                   |
| **Context continuity engine**      | Every session starts pre-loaded with relevant context and a concise "where we left off" state.                 |
| **Command-driven execution**       | Task start behavior comes from configurable commands/rules, not hardcoded task types.                          |
| **Notes model**                    | Durable notes persist with area/project/task provenance and scope-aware retrieval.                             |
| **First-principles collaboration** | Agents challenge assumptions, propose alternatives, and keep user as decision-maker.                           |
| **Generic primitives**             | A small universal model (area/project/task/spark/notes) supports many workflows without bespoke object models. |
| **External integration ready**     | Merge/release/storage integrations can be layered later without changing the core continuity model.            |

### Pain Relievers

| Pain                           | How Product Addresses It                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Activation energy to start     | Agent primes YOU: "Last time we established X, you wanted Y, where do you want to pick up?" Boulder already rolling. |
| Context loading friction       | Context continuity engine handles all priming. You never explain what you're working on.                             |
| Running out of next actions    | Triager + focus queue keep actionable tasks visible and reviewable.                                                  |
| "What should I do next?"       | Warm-start sessions and task context reduce decision friction at start time.                                         |
| Every conversation starts cold | Resumable chats with full context. Agent summarizes state when you return.                                           |
| Sequential rubric execution    | Agents can run in parallel in background. You review at checkpoints.                                                 |
| Capture friction               | Single quick-add widget. No decision about "where does this go?"                                                     |
| Ideas decay                    | Triager processes sparks automatically. Mini-development happens without you initiating.                             |
| Micro-rubrics not worth it     | Rubrics are config, not code. Easy to add lightweight filtering rubrics.                                             |
| Copy-paste for team            | Export function pushes artifacts to Drive. Thinking here, artifacts there.                                           |

### Gain Creators

| Gain                        | How Product Creates It                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Warm starts                 | Every task/session opens with context assembled and clear next decision points            |
| Co-ownership                | Interactive checkpoints keep user in control while agents accelerate execution            |
| Context continuity          | Structured notes + session history + provenance links preserve continuity                 |
| Queue security              | Home/focus surfaces show what is blocked, active, and ready                               |
| Getting to fun parts faster | Setup and recall overhead are reduced by rules, defaults, and resumable sessions          |
| Desktop-first deep work     | One primary execution surface reduces context fragmentation                               |
| Cheap rule evolution        | Rules/templates allow iterative behavior tuning without redesigning the core object model |

---

## Core Value Proposition Statement

> **The system eliminates context loading as a barrier to creative work.**
>
> Every agent conversation starts pre-loaded with: the spark, relevant research, prior outputs, your rubrics, and a summary that primes you on where things stand.
>
> You never start from zero. You never explain what you're working on. You never hunt for documents. You just continue.
>
> **The boulder is already rolling. You just keep pushing.**

---

## Key Insight

The bottleneck isn't time, organization, or even enjoyment—the work is fun once you're in it. The bottleneck is **activation energy to start**, especially when tired from a full-time job.

The difference between:

- "I need to open Notion, start a new doc, pull up my rubric, prime the AI, remember what I was doing..."
- "I'll just check the app... oh, there's a storyline conversation waiting... let me respond to this one question..."

...is the difference between not starting and accidentally doing 2 hours of productive work.

---

## Design Principles

1. **Warm starts over cold starts** — Every interaction should feel like continuing, not beginning
2. **Prime the human too** — Agent summarizes state so you remember where you left off
3. **Co-ownership, not delegation** — You make executive calls; agents help you discover breadth
4. **Fun parts fast** — Automate the unfun (research, context loading); preserve the fun (creative decisions, brainstorming)
5. **Desktop-first MVP** — Ship one strong deep-work surface first; add mobile later when core behavior is stable
6. **Sparks can die** — Active work matters; graveyard of unpromoted sparks is acceptable
7. **Context compounds** — Every agent output is available to downstream agents
