# MVP Scope (Phase 1)

**Codename:** Isagi  
**Product name:** Spark System  
**Last updated:** 2026-02-07

This document defines what we are building for the MVP.

If anything else in `docs/` conflicts with this scope, **this document wins for MVP decisions**.

---

# MVP Scope: Spark System

## Overview

A context continuity engine that eliminates activation energy barriers to creative work. Captures sparks, triages them across workstreams, and provides warm-start agent conversations with full context pre-loaded.

Built in phases, each delivering meaningful value. Starting with YouTube deep integration while maintaining lightweight triage for all workstreams.

---

## Phase 1 Scope

### What's In

#### 1. Quick Capture

- **Android-first home screen widget** — One-tap spark entry without needing to open the app
- **Widget launch is snappy** — Tapping the widget opens a lightweight capture overlay/screen (native Android)
- **Voice input** — Record audio, upload, and run server-side speech-to-text
- **Frictionless by design** — No decisions about "where does this go"

#### 2. Smart Triager (propose-only)

The Triager runs automatically on capture, but it **never auto-generates artifacts**.

It runs lightweight rubrics for each configured workstream and outputs per spark:

- Which workstreams this spark fits (YouTube, Social Marketing, etc.)
- Brief reasoning for each match
- Clarifying questions if the spark is ambiguous
- **Derived sparks** (optional) — follow-on sparks that emerge during triage/brainstorming

**Interaction model:**

- Triager may pause for your input (clarifying questions / brainstorming)
- After triage, the system proposes creating **work items** per applicable workstream
- You approve/redirect; only then are work items created

**Note:** “Propose-only” still applies — the Triager can propose derived sparks, containers, and work items, but nothing downstream is created/committed without your confirmation.

#### 3. YouTube Deep Integration

**Project Template:**
When you decide to pursue a YouTube spark, system creates a project with pre-defined tasks:

| Task                | Agent           | Pre-loaded Context                                |
| ------------------- | --------------- | ------------------------------------------------- |
| Northstar           | Northstar Agent | Spark, triager output, your Northstar rubric      |
| Research            | Research Agent  | Spark, Northstar (once complete), research rubric |
| Titles & Thumbnails | T&T Agent       | Spark, Northstar, research findings, T&T rubric   |
| Storyline           | Storyline Agent | All prior outputs, storyline rubric               |

**Research Agent Flow:**

1. Agent reviews spark + Northstar
2. Proposes 3-4 research directions based on research rubric
3. You approve, modify, or redirect
4. Agent executes deep research
5. Returns findings with sources, stored for downstream agents
6. You can ask follow-up questions triggering more research

**All Agents Have:**

- First-principles thinking — challenge your ideas, question assumptions, propose alternatives
- Context summary on resume — "Last time we established X, you wanted Y, where do you want to pick up?"
- Access to shared file system — can read outputs from other agents
- Your rubric pre-loaded — knows the structure of expected output

**Resumable Chat Interface:**

- Each task opens a chat screen (mobile-friendly; desktop is primary for deep work)
- Can pause mid-conversation and resume later
- Agent maintains full context across sessions
- Side panel shows relevant artifacts (research docs, Northstar, etc.)

Mobile supports full agent conversations for thinking/triage/decisions; coding and repo workflows remain desktop-first.

#### 4. Shared File System (artifacts)

- All agent outputs persist as artifacts
- Downstream agents can access upstream outputs
- Uses OpenCode SDK for intelligent context retrieval
- Agent prompts include hints about where relevant context lives

#### 5. Social Marketing (Lightweight)

- Triager outputs "this could be a social post" with reasoning
- Triager proposes a work item (e.g., "Draft LinkedIn post", "Draft Twitter thread")
- When you run the draft action, an agent produces a rough draft (e.g., 1-2 paragraphs / a short thread)
- Drafts are stored as artifacts in a Social Marketing backlog
- **No deep agents yet** — draft-only, validate backlog building first

---

### What's Out (Future Phases)

| Feature                                                | Why Deferred                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| Deep agents for LinkedIn, Twitter, Courses, Newsletter | Validate YouTube flow first                                    |
| Alexa skill                                            | Start with widget + voice; add Alexa later                     |
| ClickUp/Drive auto-integration                         | Manual export for now; automate later                          |
| Team collaboration features                            | Solo use case first                                            |
| Configurable workstream addition                       | Hardcode YouTube first; make configurable once patterns emerge |
| Notification/reminder system                           | See if organic check-ins suffice                               |
| Product development workstream + coding workflows      | Not in MVP                                                     |

---

## Technical Architecture

### Platform strategy (MVP)

- **Desktop is primary** — deep work happens in a desktop-first web app (SPA)
- **Mobile is capture-first** — Android app focuses on quick capture + full agent conversations for non-code work
- **Android-first** — prioritize Android; iOS is explicitly deferred
- **Widget-first capture** — native Android widget + capture overlay for "instant-feel" capture
- **Single persistent environment** — metadata + artifacts live on one always-on Linux box in v0

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                      Quick Capture                          │
│              (Widget + Voice Input + Mobile)                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                     Smart Triager                           │
│         (Runs workstream rubrics, proposes work)            │
└─────────────────────┬───────────────────────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
     ┌─────────┐ ┌───────────────┐
     │ YouTube  │ │ Social Marketing│
     │  Queue   │ │    Queue      │
     └────┬─────┘ └──────┬────────┘
          │              │
          ▼              ▼
     ┌─────────┐     ┌─────────┐
     │  Deep   │     │ Draft-Only│
     │ Agents  │     │  Agents  │
     └────┬────┘     └────┬─────┘
          │              │
          ▼              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Shared File System                        │
│              (Artifacts + OpenCode SDK)                     │
└─────────────────────────────────────────────────────────────┘
```

### YouTube Agent Pipeline

```
Spark
  │
  ▼
┌─────────────────┐
│ Northstar Agent │ ──► Northstar Doc
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Research Agent  │ ──► Research Findings + Sources
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   T&T Agent     │ ──► Title Options + Thumbnail Concepts
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│Storyline Agent  │ ──► Storyline Document
└─────────────────┘
         │
         ▼
    Ready to Record
```

### Technology Choices (MVP-level)

| Component                  | Choice                                            | Rationale                                                               |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Desktop app                | Vite + React SPA                                  | Primary surface for deep work                                           |
| Mobile app (Android-first) | Expo (React Native) with prebuild/native projects | Fast iteration with access to native widget/overlay                     |
| Widget + capture overlay   | Native Android (Kotlin)                           | "Instant-feel" capture from home screen                                 |
| Backend                    | Node.js + Express                                 | Keep it simple for v0                                                   |
| Streaming                  | Server-Sent Events (SSE)                          | Streaming output without WebSockets in v0                               |
| Auth                       | Single-user admin token                           | Avoid building full auth early; keep MVP secure enough                  |
| Persistence                | SQLite + filesystem (self-hosted)                 | Simple, durable, and easy to operate in a single persistent environment |
| Speech-to-text             | Server-side STT (self-hosted)                     | Low-friction voice capture without on-device complexity                 |
| Agent orchestration        | OpenCode SDK                                      | Already validated, handles context retrieval well                       |
| LLM                        | Claude                                            | Already using, quality is validated                                     |

---

## Interaction Model

### Hybrid Async + Interactive

**Async (background):**

- Triager runs on new sparks
- Lightweight pre-processing and context loading

**Interactive (checkpoints):**

- Approve/modify research directions
- Answer clarifying questions during development
- Make creative decisions on storyline flow
- Executive calls on hooks, angles, framing

**Key Principle:** System can only move as fast as your engagement, but it maximizes what happens between your check-ins.

### Checkpoint Behavior

When you resume a paused conversation:

1. Agent summarizes current state ("Here's where we are...")
2. Shows relevant artifacts in side panel
3. Presents the decision point or question
4. You respond, agent continues
5. Next checkpoint or completion

You're primed immediately. No "where was I?" friction.

---

## Success Criteria (2-Week Test)

| Metric                            | Target                                                | Why It Matters                                              |
| --------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| **Storylines in backlog**         | 2-3 developed storylines ready to record              | This is the output that enables videos                      |
| **Social drafts**                 | 5-10 rough drafts ready for final edit                | Tests backlog building                                      |
| **Capture frequency**             | 5+ sparks/week via quick-add                          | Validates capture habit                                     |
| **Time to storyline**             | Measurably faster than current manual process         | Validates efficiency gain                                   |
| **Actually published**            | 1 video + 2 social posts                              | Backlog is leading indicator; published is the real outcome |
| **Agent conversation completion** | Resuming and completing conversations, not abandoning | Tests whether hybrid model works                            |

### Qualitative Signals

- "I opened the app and got into flow without trying"
- "The agent already knew what I was working on"
- "I did a full brainstorming session on my phone"
- "I have options when I sit down to record"

### Warning Signs

- Conversations pile up waiting for your input (engagement bottleneck)
- Agent outputs require significant rework (quality issue)
- You stop capturing sparks (capture habit didn't stick)
- Backlog grows but nothing gets published (downstream still the bottleneck)

---

## Risks & Mitigations

| Risk                                                     | Likelihood | Mitigation                                                                               |
| -------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| Hybrid requires too-frequent engagement                  | Medium     | Track checkpoint pile-up; allow some async completion if needed                          |
| Agent quality insufficient for "last mile" refinement    | Low        | Already validated agent quality through manual use                                       |
| Voice capture too lossy                                  | Medium     | Triager handles disambiguation; iterate on capture UX                                    |
| Capture doesn’t feel instant (cold-start + context load) | Medium     | Keep capture overlay lightweight; defer non-essential work until after capture           |
| Build takes too long, lose momentum                      | Medium     | Strict Phase 1 scope; use AI coding assistance                                           |
| Still hit wall at recording (downstream bottleneck)      | Medium     | Accept system improves development, not production; 30-50% improvement is still valuable |

---

## Out of Scope Clarifications

**This system is NOT:**

- A full project management tool (use ClickUp for that)
- A content storage system (final artifacts go to Drive)
- A team collaboration platform (solo creator focus)
- A scheduling/publishing tool (handles development, not distribution)

**This system IS:**

- A context continuity engine
- A warm-start provider for creative work
- An activation energy eliminator
- A thinking partner with persistent memory

---

## Next Steps

1. **Technical spike:** Validate OpenCode SDK integration for shared context retrieval
2. **Capture UX:** Build minimal widget + voice input prototype
3. **Triager prompt:** Design and test triager rubric for YouTube/Social Marketing
4. **One agent end-to-end:** Build Northstar agent with full context loading, test the "warm start" experience
5. **Iterate:** Expand to full YouTube pipeline based on learnings
