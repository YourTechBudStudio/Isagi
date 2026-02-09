# Isagi — mental model

**Last updated:** 2026-02-07

This document defines the universal concepts and invariants we’re using while designing Isagi.

## Glossary (universal concepts)

### Workstream (Area)
A stable lens that groups related work and capabilities (e.g., **YouTube**, **Social Marketing**, **Product Development**). Workstreams are not templates/instances.

Workstreams can:
- own artifacts (e.g., living blueprints, audience personas)
- define **processor profiles** (derived agents)
- provide UI surfaces

**MVP workstreams (Phase 1):**
- **YouTube** (deep pipeline)
- **Social Marketing** (draft-only pipeline; platform-specific processors)

### Spark
A raw captured input (often a one-liner). Sparks exist so you don’t lose ideas.

Spark view/lifecycle states:
- `inbox` → `backlog` → `active` → `archived`
- or `rejected`

Cancellation semantics:
- Rejecting/archiving a spark **cancels in-flight sessions** that were spawned from it (via derived work items).
- **Committed artifacts are not deleted**; they keep provenance links back to the spark.

### Container (Scope, global)
A global context bucket that work belongs to. Containers are cross-linkable across workstreams.

Examples:
- `Project: Fluidcast`
- `Video: Interleaved Thinking`

Containers have a **ContainerType** (defined via YAML manifest) plus attributes.

### Work Item
The unit of work you pick up and act on. A work item can be handled by a **human** or an **agent**.

Key properties:
- primary `container_id`
- optional `spark_id`
- `status`, `priority`
- `blocked_by[]` dependencies
- linked artifacts
- actions
- sessions

### Artifact
An output (document, blob, link, or structured dataset). Artifacts can be versioned (“living artifacts”).

Ownership and visibility:
- Each artifact is owned by exactly **one workstream**.
- Artifacts can be **private** or **public**.
  - **Public** artifacts may be referenced/used across workstreams.
- Ownership still stays with a single workstream.

#### Social artifacts (Phase 1)

For Social Marketing, drafts are stored as full artifacts (not just triage output) with platform metadata (e.g., `platform=linkedin|twitter`).

### Action
A runnable operation attached to a work item. Actions are executed by processors and create sessions.

Examples:
- “Run research”
- “Brainstorm North Star”
- “Start/Resume coding env”
- “Draft storyline”

### Processor
An entity that can execute actions.

Types:
- **Human processor** (the user)
- **Agent processor** (triager, brainstormer, research, documentation, etc.)

### Processor Profile (YAML-first)
A workstream-defined derivative of a universal agent processor.

Example:
- `universal.brainstorm` → `youtube.north_star`

Profiles define:
- prompt pack / rubric
- how inputs are selected (selectors)
- expected outputs (artifact(s) written)
- whether/where they may emit gates

### Session (unified execution record)
A session is the durable record for “something happening” tied to a work item.

Session subtypes:
- **ChatSession**: interactive human↔agent conversation
- **AgentSession**: background agent execution started by an action
- **CodeSession**: remote coding environment (IDE + TTY)

Sessions can be running, paused, waiting for a gate, done, or cancelled.

### Context Pack (Warm Start Brief)

A **Context Pack** is the computed bundle that makes a session feel like continuing rather than beginning.

Every time you open or resume a session, the system should assemble a Context Pack containing (at minimum):
- the spark (if any) and triager output
- relevant artifacts (upstream outputs, pinned artifacts, and any required rubrics)
- a short “where we left off” summary
- the next decision point (or the active GateRequest)

This is the core invariant behind “warm starts” and “context continuity.”

### GateRequest
A request for human input emitted by a session (typically an AgentSession).

GateRequests:
- appear in the Focus Queue under a dedicated **Gates** section
- can carry structured payloads (forms/patches) and/or open a chat
- when completed, resume the paused session

## Input selection (artifact selectors)

Actions/profiles select inputs via a small DSL:

- `label:<x>` — artifacts with a label
- `container_all` — all artifacts in the work item’s container
- `workstream_all` — all artifacts owned by the work item’s workstream

Additionally:
- **Pinned artifacts on a work item are always included** as inputs.

Labels should follow light conventions to avoid entropy (e.g., `yt/*`, `social/*`, `prod/*`).

## Home + focus model (UX invariants)

- Capture is primarily via quick-add widgets, not the home screen.
- Home optimizes for **focused work**:
  - **Resume**: open the last relevant session attached to the most recently active work item
  - **Focus Queue**: a small list of work items
  - **Gates**: GateRequests needing input
  - A lightweight indicator for pending triage

## Triage model

The **Triager** is an agent processor.

Triage flow:
1) Triager runs automatically on capture and expands/clarifies a spark.
2) Triager proposes which workstreams fit, with reasoning, and may ask clarifying questions.
3) Triager consults manifests/templates to decide what could be created.
4) Triager proposes:
   - containers (optional)
   - initial work items (per applicable workstream)
   - suggested actions
5) User confirms/edits; objects are created.

**Invariant:** Triager is **propose-only**. It does not auto-generate artifacts; artifacts are created by running actions that start sessions.

## Execution + storage model (hybrid)

**MVP default (Phase 1): single persistent environment**

- Canonical storage:
  - metadata in a database
  - artifact bodies/blobs on a persistent filesystem
- Execution:
  - actions run in the same always-on environment

**Optional future direction (post-MVP): control/execution split**

- Canonical storage:
  - metadata in a database
  - artifact bodies/blobs in object storage
- Execution:
  - many actions can run in control-plane context
  - actions that need tooling/filesystem can materialize selected artifacts into an ephemeral sandbox (Sprite/Fly) and write outputs back as artifacts
- Code sessions:
  - resumable environment
  - provide separate actions: **Open IDE** and **Open TTY**
  - use TTL + reference counting: a session can be shared by multiple work items and is destroyed when unreferenced

## Example: YouTube spark → video

Spark: “interleaved thinking is cool, possible video?”

1) Triage expands the spark (Anthropic feature, target persona(s), livestream+recorded, code demo intent).
2) Triager proposes a `Video` container.
3) User creates work items such as Research, North Star, Storyline, Code Demo.
4) Running an action creates a session; the session may emit GateRequests (e.g., approve research plan, pick primary+secondary persona).
5) Sessions produce artifacts (dossier, docs, outlines). Follow-ups are suggested; chaining is manual in v1.

## Not in MVP

- Product development workstreams/coding workflows.

## What’s undecided

- The exact shape of ContainerType manifests and ProcessorProfile YAML schemas.
- How much “auto-trigger” exists in v1 vs fully manual actions.
- The boundary between control-plane execution and sandbox execution.
