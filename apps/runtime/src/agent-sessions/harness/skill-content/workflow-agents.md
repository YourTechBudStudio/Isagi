# Agent work in workflows

Read [Workflow authoring](workflows.md) for graph structure and package checks. Use the installed `operations.d.ts` and `launch.d.ts` for exact capability, result, prompt, and conversation types.

## Choose a capability

| Capability on `ctx`      | Returns / use                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `spawnAgentSession`      | Interactive session handle with pane ID and turn target                                        |
| `sendAgentPrompt`        | Turn target for an existing session                                                            |
| `runHeadlessAgent`       | Operation handle, not its completed output                                                     |
| `captureEvidence`        | Durable reference to selected immutable content; see [Workflow evidence](workflow-evidence.md) |
| `getConversationHistory` | Role-tagged messages for a session                                                             |
| `closePane`              | Closes a pane owned by the workflow when no longer needed                                      |
| `setUiFeedback`          | Meaningful phase/message for the user                                                          |
| `log`                    | Durable diagnostic context                                                                     |

Pass the spawn/send target directly to `wait.agentTurn`. Send one prompt per controlled turn; allow it to settle before another prompt or a harness conversation reset/switch. Persist stable Isagi handles needed by later nodes, rather than provider/native-session identity. Native conversation history can be unavailable; handle that explicitly rather than treating an empty response as success. If a routing or response-reading segment fails after this wait, a human-triggered Retry may select the latest observed turn in the same durable agent session; workflow code still uses only the Isagi session handle and ordinary event/conversation APIs.

## Interactive turn and observation

This reusable graph sends one prompt, handles every turn outcome, and reads the response in a separate operation. It returns conversation data for its caller to interpret; successful transport does not establish that the task succeeded. Its caller owns the existing session and its cleanup.

```ts
import {
  complete,
  createGraph,
  edge,
  operation,
  outcome,
  reduce,
  suspend,
  wait,
  type WorkflowConversationMessage,
} from '@yourtechbudstudio/isagi-workflow-sdk';

type Parameters = { readonly agentSessionId: number; readonly prompt: string };
type State = Parameters & {
  readonly messages: readonly WorkflowConversationMessage[];
  readonly failure: string | null;
};
type Output = Pick<State, 'messages' | 'failure'>;

export const AgentTurn = createGraph<State, {}, Parameters, Output>({
  key: 'AgentTurn',
  title: 'Ask agent and collect response',
  intent: 'operational',
  init: (_destination, parameters) => ({ ...parameters, messages: [], failure: null }),
  state: {
    agentSessionId: reduce.replace<number>(),
    prompt: reduce.replace<string>(),
    messages: reduce.replace<readonly WorkflowConversationMessage[]>(),
    failure: reduce.replace<string | null>(),
  },
  entry: 'send',
  nodes: {
    send: operation(async (ctx, state) => {
      const target = await ctx.sendAgentPrompt({
        agentSessionId: state.agentSessionId,
        prompt: state.prompt,
      });
      return suspend({ wait: wait.agentTurn(target) });
    }),
    read: operation(async (ctx, state) =>
      complete({
        update: { messages: await ctx.getConversationHistory(state.agentSessionId) },
      }),
    ),
  },
  edges: {
    afterSend: edge({
      from: 'send',
      to: ['read', 'turnFailed'],
      choose: (_state, event) => {
        if (event.kind !== 'agent_turn') throw new Error('Expected agent turn');
        return event.outcome === 'ended'
          ? { to: 'read' }
          : { to: 'turnFailed', update: { failure: event.reason } };
      },
    }),
    afterRead: edge({ from: 'read', to: ['collected'], choose: () => ({ to: 'collected' }) }),
  },
  outcomes: {
    collected: outcome({
      kind: 'success',
      output: (state) => ({ messages: state.messages, failure: null }),
    }),
    turnFailed: outcome({
      kind: 'failure',
      output: (state) => ({ messages: state.messages, failure: state.failure }),
    }),
  },
});
```

Register this with `subgraph`: map the parent's session ID and prompt through `parameters`, then map `result.output` through `onResult`. In the parent edge, inspect `result.outcomeKind` from the `subgraph` event and choose interpretation, a bounded recovery route, or human input. Keep those business choices outside the reusable turn graph.

For a new session, use `spawnAgentSession` in an operation and persist its `agentSessionId` and `paneId` before later work needs them. Close panes created by the workflow when finished with them; preserve the user's launch pane.

## Headless work

Launch a headless operation, suspend on its handle, and inspect its delivered result. This fragment stores the output for a later decision and routes failed/interrupted work to an explicit recovery node; the containing graph defines that recovery policy and budget.

```ts
import {
  edge,
  eventGuards,
  operation,
  suspend,
  wait,
  type HeadlessOperationResult,
} from '@yourtechbudstudio/isagi-workflow-sdk';

type State = {
  readonly operationId: string | null;
  readonly output: string | null;
  readonly result: HeadlessOperationResult | null;
};
export const judge = operation<State, State>(async (ctx) => {
  const handle = await ctx.runHeadlessAgent({
    harness: 'codex',
    prompt: 'Review the current diff. Report findings.',
  });
  return suspend({ update: { operationId: handle.operationId }, wait: wait.headlessAgent(handle) });
});
export const afterJudge = edge<State, State>({
  from: 'judge',
  to: ['interpret', 'recover'],
  choose: (state, event) => {
    if (state.operationId === null) throw new Error('Missing headless operation');
    const result = eventGuards.requireHeadless(event, state.operationId);
    if (result.status !== 'completed') return { to: 'recover', update: { output: null, result } };
    return { to: 'interpret', update: { output: result.output ?? '', result } };
  },
});
```

The containing graph initializes `result` to `null` and registers a replacement reducer for it. The recovery operation can inspect `state.result` for status, error, exit code, and interruption details, including partial output and stop information, before choosing follow-up work.

For several headless tasks, launch them and pass their handles to `wait.headlessAgent(handles)`. Results arrive in declared input order; inspect each status, matching by operation ID where clearer. Partial output from an interrupted operation is not a completed judgment. Read [Workflow recovery](workflow-recovery.md) before adding retry-specific handling or replacing interrupted work.

## Prompts and judgments

Give unattended agents a goal, relevant inputs, constraints, acceptance criteria, and stop conditions. Give them a path for uncertainty that does not depend on someone answering mid-turn; place required human decisions in graph waits. Keep authorization boundaries explicit when the requested work can have external effects.

Read the latest complete assistant turn across its messages and parts. Capture the response before building the judgment prompt, passing the retained turn target as its source; [Workflow evidence](workflow-evidence.md) explains Retry reuse and later-visit recapture. Validate the evidence or structured output needed for the next route. A separate judgment agent is useful when a semantic decision is needed, but is not required for every workflow. When using structured judgments, keep the prompt, parser, and result type coherent; cover each meaningful outcome, including work completed beyond the requested phase when that changes what follows. Test invalid responses and consequential routes. Log parse failures with enough context to diagnose them.

Change feedback when the business-facing phase changes rather than at every internal transition. Before intentional failure or human escalation, explain the problem and next action through feedback and log the relevant evidence from an operation. Pure routing cannot call these capabilities.

## Prompt modifiers

All three agent-input capabilities accept optional `prompt` and `modifiers`. Provide plain names such as `{ kind: 'skill', name: 'review' }`, without leading `/` or `$`, whitespace, or Unicode control/format characters. Isagi renders native tokens. Skills stack in caller order; a command must be the only modifier. At least a modifier or non-whitespace prompt is required.

```ts
import type { WorkflowPromptInput } from '@yourtechbudstudio/isagi-workflow-sdk';

export const reviewInput = {
  modifiers: [{ kind: 'skill', name: 'review' }],
  prompt: 'Review the diff against the acceptance criteria.',
} satisfies WorkflowPromptInput;
```

| Harness    | Skill           | Command   |
| ---------- | --------------- | --------- |
| `pi`       | `/skill:<name>` | `/<name>` |
| `opencode` | `/<name>`       | `/<name>` |
| `claude`   | `/<name>`       | `/<name>` |
| `codex`    | `$<name>`       | `$<name>` |

Rendering does not check that a skill or command exists or that a harness applies stacked skills. Use command modifiers for native prompt templates/commands that start an agent turn. UI-only commands such as `/help`, `/settings`, or `/model` do not satisfy a turn wait. Pi and OpenCode provide first-class command syntax; on Claude and Codex a command renders like a skill. Headless OpenCode may treat slash-looking text as ordinary prompt text rather than invoke a native command.
