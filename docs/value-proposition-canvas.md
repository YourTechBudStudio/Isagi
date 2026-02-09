# Value Proposition Canvas (source of truth)

**Codename:** Isagi  
**Product name:** Spark System  
**Last updated:** 2026-02-07

If anything else in `docs/` conflicts with this canvas, **this document wins**.

**MVP constraint:** In Phase 1, the Triager is **propose-only** (see [MVP scope](./mvp-scope.md)). Any “development” described below should be interpreted as *proposing work items and enabling warm-start sessions*, not auto-generating artifacts.

---

# Value Proposition Canvas: Spark System

## Customer Profile

### Jobs to be Done

| Job | Type | Priority |
|-----|------|----------|
| Post content consistently across platforms (YouTube weekly, LinkedIn 2x/week, Twitter often) | Core | Highest |
| Develop raw ideas into content-ready artifacts (Northstar, storylines, drafts) | Core | High |
| Research topics before creating content | Core | High |
| Maintain a healthy backlog/pipeline so I never run dry | Core | High |
| Capture ideas quickly when they occur (on the go, voice, mobile) | Supporting | High |
| Share artifacts with team members (editor) | Supporting | Medium |
| Track progress on content projects | Supporting | Low |

### Pains

| Pain | Severity |
|------|----------|
| **Activation energy to start** — even though the work is fun, initiating feels like pushing a boulder uphill | Severe |
| **Context loading friction** — priming AI with context, remembering where I left off, explaining what I'm working on | Severe |
| **Running dry on social media** — no backlog when I need to post, even though I have ideas all the time | Severe |
| **Research friction** — specifically figuring out *what* to research | Severe |
| **Every conversation starts cold** — no continuity between sessions | Moderate |
| **Manual rubric execution is sequential and tedious** — storyline alone takes 6 hours across 2 days | Moderate |
| **Capture friction** — confusion about where to put ideas | Moderate |
| **Ideas decay** — lose context, forget about them, laundry list graveyard | Moderate |
| **Small/micro rubrics aren't worth creating manually** | Moderate |
| **Context scattered** — have to copy-paste artifacts to share with team | Low |

### Gains

| Gain | Importance |
|------|------------|
| **Warm starts** — when I sit down to work, context is loaded, I'm primed, the boulder is already rolling | Critical |
| **Co-ownership** — building together with AI, not just reviewing; feeling challenged and discovering breadth | Critical |
| **Context continuity** — agent knows the spark, research, prior outputs, my rubrics; I never start from zero | Critical |
| **Pipeline visibility** — "I have 3-4 storylines queued" feeling of security | High |
| **Getting to the fun parts faster** — system handles unfun parts (research, context loading) so I can do creative work | High |
| **Parallelized development** — multiple rubrics run simultaneously in background | High |
| **Mobile-first capture + check-ins** — capture on phone; quick check-ins can escalate into deeper work (often on desktop) | Medium |
| **Cheap rubric creation** — can make micro-rubrics for small filtering tasks | Medium |

---

## Value Map

### Products & Features

| Feature | Description |
|---------|-------------|
| **Quick capture** | Home screen widget + voice input. Frictionless spark entry on mobile. |
| **Smart triager** | Runs lightweight rubrics per workstream. Output: "This spark fits YouTube, LinkedIn, Twitter" with reasoning + clarifying questions. |
| **Resumable chat agents** | Each task opens a chat screen. Can pause and resume. Conversations persist with full context. Mobile-friendly design; desktop is primary for deep work. |
| **Context continuity engine** | Every conversation starts pre-loaded with: the spark, relevant research, prior outputs, your rubrics, and a summary that primes you on where things stand. |
| **Research agent** | Proposes research directions → you approve/modify → runs deep research → returns findings with sources. All stored for downstream agents. |
| **Workstream agents** | Northstar agent, Titles/Thumbnails agent, Storyline agent—each pre-primed with your rubrics and access to prior outputs. |
| **Shared file system** | All artifacts persist. Research outputs available to Northstar agent. Northstar available to Storyline agent. Context compounds. Uses OpenCode SDK for intelligent retrieval. |
| **First-principles collaboration** | All agents challenge, question, propose alternatives. You make executive calls. Agents help you discover breadth through criticism and alternate ideas. |
| **Project templates** | "Create YouTube video" spawns a project with pre-defined tasks. Each task links to its agent with context pre-loaded. |
| **Export to Drive/ClickUp** | Final artifacts pushed to external systems for team access. System is for thinking, not storage. |

### Pain Relievers

| Pain | How Product Addresses It |
|------|--------------------------|
| Activation energy to start | Agent primes YOU: "Last time we established X, you wanted Y, where do you want to pick up?" Boulder already rolling. |
| Context loading friction | Context continuity engine handles all priming. You never explain what you're working on. |
| Running dry on social media | Triager continuously develops sparks into draft posts. Backlog builds passively. |
| "What should I research?" | Research agent proposes directions based on topic + rubric. You approve, it executes. |
| Every conversation starts cold | Resumable chats with full context. Agent summarizes state when you return. |
| Sequential rubric execution | Agents can run in parallel in background. You review at checkpoints. |
| Capture friction | Single quick-add widget. No decision about "where does this go?" |
| Ideas decay | Triager processes sparks automatically. Mini-development happens without you initiating. |
| Micro-rubrics not worth it | Rubrics are config, not code. Easy to add lightweight filtering rubrics. |
| Copy-paste for team | Export function pushes artifacts to Drive. Thinking here, artifacts there. |

### Gain Creators

| Gain | How Product Creates It |
|------|------------------------|
| Warm starts | Every task you open has context loaded, research available, agent primes you on where things stand |
| Co-ownership | Hybrid model: async background work + interactive checkpoints where you steer and make executive calls |
| Context continuity | Shared file system + OpenCode SDK for intelligent retrieval. Agents access each other's outputs. |
| Pipeline security | Dashboard shows: "3 storylines ready, 7 LinkedIn drafts in backlog" |
| Getting to fun parts faster | Research (unfun) is pre-done. Context loading (unfun) is automated. You jump straight to creative decisions. |
| Mobile-first capture + check-ins | Chat-based interface works well on phone for check-ins, but deep work primarily happens on desktop. |
| Cheap rubrics | Rubric = prompt template + triggers. Add new ones without coding. |

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
5. **Mobile-first capture** — Check-ins on phone should naturally escalate to deeper work (often on desktop)
6. **Sparks can die** — Active work matters; graveyard of unpromoted sparks is acceptable
7. **Context compounds** — Every agent output is available to downstream agents
