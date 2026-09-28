# 0009-explicit-retry-agent-turn-recovery

status: accepted
date: 2026-09-13
revised: 2026-09-27

## Decision

One rule decides which agent turn answers an agent-turn wait, and it applies the same way to ordinary waiting, to Resume and to Retry: **the latest turn wins**.

```text
turns in the target session that started at or after the prompt's sentAt → take the LATEST
  running → keep waiting;  ended → deliver "ended";  failed → deliver "failed"
```

A newer turn always replaces an older one. If a harness fails and the person then continues the agent by hand (or the harness recovers on its own), the newer turn is what answers the wait. A Retry of an execution that waited on an agent turn therefore needs no replacement machinery: it refreshes the session's observation, re-checks the wait with the same rule, and delivers whatever the latest turn says. A session whose turn died with its process is delivered as `interrupted` with `session_died`.

The reply is read from the turn that was delivered: when an ended or failed turn answers a wait, the runtime reads that turn's last assistant text and records it on the operation that sent the prompt. If it cannot be read, the operation records that the reply is unavailable and the run continues. `getConversationHistory` reads the session's latest conversation, with no restriction to a selected turn.

## Motivation

A harness may fail, then finish the task after automatic recovery or a human pressing Continue. Replaying only the saved failure makes Retry fail repeatedly even though a usable response now exists. The earlier design solved this with exact-turn pinning during ordinary waiting, a separate replacement-selection path for explicit Retry, recovery waits, frozen turn associations, ambiguity blocking and memoized conversation reads. Each piece answered a real edge case, but together they made agent waits the hardest part of the runtime to reason about. One rule used everywhere is simpler, and it gives the behaviour people expect: whatever the agent did last is what the workflow sees.

## Consequences

- There is no exact-turn pinning, no recovery wait, no turn-association state and no memoized conversation read. The only durable facts are the wait's target (agent session and `sentAt`) on the execution and the harness's own turn records.
- Retry refreshes the targeted session's observation before re-checking, rather than trusting the last background poll. A refresh error refuses the Retry and leaves the failed run unchanged. Resume and startup also refresh first, falling back to the last observation if the refresh fails.
- The rule can pick a turn the workflow did not cause, for example a turn the person started in the same session for another reason. The workflow sees that turn's outcome and reply. This is accepted: a person working in a workflow's agent session is taken to be working on the workflow's behalf.
- `sentAt` uses the runtime's clock, captured immediately before the prompt is written to the PTY, and turn starts use the harness's clock; the comparison is `>=`. A turn that starts within clock skew of the prompt can be misread. This is a known limitation.
- Authors do not implement harness-specific recovery or store harness identities. Recovery that needs a person is authored in the graph: ask the user to continue the agent, then re-arm `wait.agentTurn` on the same target.
- Historical failures stay in the execution and event history; a Retry adds a new execution and never rewrites the failed one as a success.
