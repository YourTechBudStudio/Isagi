# 0007-agent-harness-architecture

status: accepted
date: 2026-11-26
supersedes: 0007-per-invocation-harness-integration (2026-06-15, updated 2026-10-13)

## Decision

### Harnesses and drivers

A harness is Isagi's integration with one agent product (Claude Code, Codex, Pi, OpenCode, Antigravity). Every harness implements one small interface and is listed once; every other list of harnesses (contracts, config schemas, tables, web labels, the workflow SDK) derives from that list or is checked against it.

A harness runs its agent through one or more drivers and declares which it has:

- **terminal driver:** the agent's own TUI in a PTY.
- **SDK driver:** the agent's SDK, through a thin Isagi-owned wrapper.

Each driver is a vertical implementation: it owns its launch and its observation. The harness owns what its drivers share: the native session identity, conversation reading, detection, input encoding, prompt tokens and the `isagi-docs` install target.

### Controllers

A pane hosts an agent session. A controller is how the person interacts with it, and an agent session has one controller at a time:

- **chat UI:** runs on either driver. On the terminal driver it is the agent's TUI; on the SDK driver it is Isagi's own chat view.
- **voice (Fluidcast):** runs on the SDK driver only.

Changing controller on the same driver keeps the agent running. Changing driver replaces the agent process and resumes the same native conversation; it is meant to happen between turns, and Isagi does not guard it.

Workflows are not a controller. They inject prompts through the chat UI controller, on either driver, where the person can watch them. Voice does not accept injected prompts.

### Observation

The harness owns observation end to end. Given an agent session, it produces a stream of observations in one shared vocabulary; nothing outside the harness reads its native records.

The vocabulary is modeled on the Program Status Protocol (OSC 7501): `idle`, `working`, `done`, `blocked` (with kind `permission`, `question` or `auth`), `error`, plus native session identity changes and readiness for input. It is Isagi's internal language and is not tied to terminals.

Each driver chooses its sources for reliability:

- terminal program-status reports (OSC 7501), which the runtime records from the PTY stream;
- per-invocation hooks, plugins and extensions;
- events from the SDK wrapper, which report the worker agent, never the controller's own model (for example the voice model);
- read-only native artifacts such as transcripts, logs and session stores, scoped to sessions Isagi launched.

Hooks are not avoided for their own sake. Where program-status reports exist they are the primary source of live state, and other sources supply what they lack: identity, turn outcomes and reply text.

Records Isagi captures (program-status reports, hook events, SDK events) are stored as received, inside Isagi's envelope with the runtime's timestamp, in the agent session's runtime-owned folder. Native artifacts are read in place and never copied or modified. All interpretation happens at read time, inside the harness, so a faulty interpreter can be fixed without losing history.

### Turns and attention

Attention answers "what is the agent doing now"; turns answer "has the work a prompt started finished". They are derived separately from the same observations:

- `working` is attention working and starts a turn. Turn start times use the runtime's clock.
- `done` ends the turn. `error` fails it; `failed` is reserved for harness errors.
- `blocked` is attention waiting. Permission, question and sign-in stay distinct in the observations and are one "needs you" to the person.
- A person's interrupt (including denying a permission) makes attention "needs you" at once but does not end the turn; the next turn supersedes it.
- A turn whose process died ends as `session_died`.

Attention behaves the same inside and outside workflows. ADR 0009 decides which turn answers a workflow wait.

### Native session identity

The native session ID belongs to the harness. It is captured after the first prompt for every harness, even one that could accept a pre-assigned ID, and it follows switches inside the agent (`/clear`, `/new`, forks). Other modules get answers instead of the ID: whether and how the session can resume, opaque turn references for reading a turn's reply, and diagnostics. A copy may be recorded for diagnostics, such as on a workflow operation; nothing decides behavior from it.

### Input

The harness owns how text reaches its agent: how a prompt is encoded, how a newline is inserted and when the agent is ready to receive input. Callers never write harness-specific bytes.

### Invocation boundary

Launching, restoring, observing or instrumenting an agent never mutates global, user or project harness configuration. Hooks, plugins, environment variables, flags and generated files are injected only through the invocation Isagi launches, and generated files live under runtime-owned paths. Answering a terminal capability query, such as the OSC 7501 support query, is the runtime acting as the terminal, not a configuration change.

The sole global exception is the reserved `isagi-docs` skill. When the person enables its installation for a harness, Isagi may replace that harness's native global skill folder with a complete copy of the skill package, staged and backed up beside the destination and restored on failure. Each installed copy is self-contained, and disabling installation leaves the last published copy untouched.

### Honest degradation

A missing or unreadable source, a resume that started a fresh conversation, an unsupported harness version or an unobservable state surfaces as degraded with stable codes and diagnostics, never as success or fabricated history. User-facing copy stays web-owned.

## Motivation

The previous decision named hooks as the observation source, passed hook settings into SDK runs, and let the runtime read harness files, session IDs and Codex rollouts directly. Each new harness leaked into shared code, and hooks missed interrupts, permission prompts and resolution of waits that every harness now reports through OSC 7501.

Isagi will also drive agents through SDKs for a custom chat UI and for voice, where no terminal exists. Separating harness, driver and controller, and letting each harness own its observation behind one vocabulary, lets that arrive by adding a driver rather than reshaping shared code. Keeping raw records and read-time interpretation preserves the debuggability the previous decision was written for.

## Consequences

- A new harness is one implementation of the interface plus one entry in the harness list; shared code does not change.
- The PTY layer stays generic (ADR 0005): it answers the program-status support query, records reports as terminal facts, and never interprets them per harness.
- Observations, turn edges and attention come from the harness; the shared reducer, workflow waits and attention badges never branch on a harness.
- Switching an existing session from the terminal driver to voice interrupts any running turn; timing the switch is the person's responsibility.
- Turn starts and `sentAt` share the runtime's clock, which removes ADR 0009's clock-skew limitation.
- Read-side interpreters depend on harness-native formats and must parse defensively, tolerate version drift and be tested against captured native records.
- Records derived from the previous hook-based sources are not reinterpreted; turns recorded before this decision may read as degraded.
- Per-harness event names, flags and paths live in the harness implementations, not in this ADR, so it stays stable as harness versions change.
