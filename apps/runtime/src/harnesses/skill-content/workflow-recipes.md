# Workflow recipes

Building blocks to adapt, not to copy whole. Each code block compiles against the SDK on its own. Rules behind them: [Graphs](workflow-graphs.md) and [Agents](workflow-agents.md).

## Agent turn

One prompt to a new or existing session, waited to its end. A failed turn hands control to the person instead of failing the run: they finish the agent in its pane, press Continue, and their turn answers without a new prompt. A dead session returns to the caller as data. Register it with `subgraph` wherever a graph needs an agent to do something.

```ts
import {
  createGraph,
  edge,
  operation,
  outcome,
  reduce,
  suspend,
  wait,
  type AgentTurnTarget,
  type NodeEvent,
  type WorkflowAgentHarness,
} from '@yourtechbudstudio/isagi-workflow-sdk';

/** `paneId` is null for a session the workflow does not own, such as the launching agent. */
export type Agent = { readonly agentSessionId: number; readonly paneId: number | null };
export type TurnParameters = {
  readonly label: string;
  readonly session: { readonly spawn: WorkflowAgentHarness } | { readonly existing: Agent };
  readonly prompt: string;
};
export type TurnOutput = { readonly agent: Agent; readonly interrupted: string | null };

type State = TurnParameters & {
  readonly agent: Agent | null;
  readonly turn: AgentTurnTarget | null;
  readonly interrupted: string | null;
};

const route = (state: State, event: NodeEvent) => {
  if (event.kind !== 'agent_turn') throw new Error(`Unexpected ${event.kind} event`);
  if (event.outcome === 'ended') return { to: 'ended' };
  if (event.outcome === 'failed') return { to: 'askUser' };
  return { to: 'interrupted', update: { interrupted: `${state.label}: ${event.reason}` } };
};
const afterTurn = ['ended', 'askUser', 'interrupted'];

export const AgentTurn = createGraph<State, {}, TurnParameters, TurnOutput>({
  key: 'AgentTurn',
  title: 'Agent turn',
  label: (parameters) => parameters.label,
  init: (_destination, parameters) => ({ ...parameters, agent: null, turn: null, interrupted: null }),
  state: {
    label: reduce.replace<string>(),
    session: reduce.replace<TurnParameters['session']>(),
    prompt: reduce.replace<string>(),
    agent: reduce.replace<Agent | null>(),
    turn: reduce.replace<AgentTurnTarget | null>(),
    interrupted: reduce.replace<string | null>(),
  },
  entry: 'send',
  nodes: {
    send: operation(async (ctx, state) => {
      if ('spawn' in state.session) {
        const spawned = await ctx.spawnAgentSession({ harness: state.session.spawn, prompt: state.prompt });
        const agent = { agentSessionId: spawned.agentSessionId, paneId: spawned.paneId };
        return suspend({ update: { agent, turn: spawned }, wait: wait.agentTurn(spawned) });
      }
      const agent = state.session.existing;
      const turn = await ctx.sendAgentPrompt({ agentSessionId: agent.agentSessionId, prompt: state.prompt });
      return suspend({ update: { agent, turn }, wait: wait.agentTurn(turn) });
    }, { title: 'Send the prompt' }),
    askUser: operation(async (ctx, state) => {
      await ctx.setUiFeedback({ kind: 'warning', phase: `${state.label} stopped`, message: 'Finish the agent by hand, then Continue.' });
      return suspend({ wait: wait.userContinue(`${state.label} stopped. Finish it by hand, then Continue.`) });
    }, { title: 'Ask the person to finish the agent' }),
    recheck: operation(async (_ctx, state) => suspend({ wait: wait.agentTurn(state.turn!) }), {
      title: 'Check the latest turn',
    }),
  },
  edges: {
    afterSend: edge({ from: 'send', to: afterTurn, choose: route }),
    afterAskUser: edge({ from: 'askUser', to: ['recheck'], choose: () => ({ to: 'recheck' }) }),
    afterRecheck: edge({ from: 'recheck', to: afterTurn, choose: route }),
  },
  outcomes: {
    ended: outcome({ kind: 'success', output: (state) => ({ agent: state.agent!, interrupted: null }) }),
    interrupted: outcome({ kind: 'failure', output: (state) => ({ agent: state.agent!, interrupted: state.interrupted }) }),
  },
});
```

To resend automatically on a transient harness error before asking the person, add a `resubmit` node with a counter in state and route `failed` turns there while budget remains.

## Read a reply

The text of a session's latest complete assistant turn, for a judgment or for the next agent's prompt. Call it in its own node with `await ctx.getConversationHistory(agentSessionId)` and store the result; `null` means there is nothing to read.

```ts
import type { WorkflowConversationMessage } from '@yourtechbudstudio/isagi-workflow-sdk';

const text = (message: WorkflowConversationMessage) =>
  message.parts
    .filter((part) => part.type === 'text' && part.state !== 'streaming')
    .map((part) => part.text)
    .join('\n')
    .trim();

export function latestAssistantTurn(history: readonly WorkflowConversationMessage[]): string | null {
  const lastUser = history.findLastIndex((message) => message.role === 'user');
  const turn = history
    .slice(lastUser + 1)
    .filter((message) => message.role === 'assistant')
    .map(text)
    .filter((part) => part.length > 0)
    .join('\n\n');
  return turn.length > 0 ? turn : null;
}
```

## Classify a reply

A headless judgment over text the workflow hands it. The routes below are those of the review loop that follows. Unparseable or failed judgments retry within a budget, then return `unknown` so the caller can ask the person.

```ts
import {
  createGraph,
  edge,
  eventGuards,
  operation,
  outcome,
  reduce,
  suspend,
  wait,
} from '@yourtechbudstudio/isagi-workflow-sdk';

export type ReviewRoute = 'human-decision' | 'final-fixer' | 'complete' | 'continue' | 'unknown';
type Parameters = { readonly review: string };
type State = Parameters & { readonly operationId: string | null; readonly attempts: number; readonly route: ReviewRoute };

const prompt = (review: string) => `You are an unattended routing judgment for a review loop.
Classify the reviewer's response itself, not the stage you expect it to be in. Choose the first route that applies:
1. human-decision: its Human Escalation section raises an escalation.
2. final-fixer: it closes the loop with "No re-review needed." but lists Nit findings.
3. complete: it closes the loop with "No re-review needed." and lists no Nits.
4. continue: anything else.
Reply with only {"route":"human-decision"|"final-fixer"|"complete"|"continue"}.

<review>
${review}
</review>`;

const routes: readonly string[] = ['human-decision', 'final-fixer', 'complete', 'continue'];

export function parseRoute(output: string): ReviewRoute {
  try {
    const value: unknown = JSON.parse(output.trim());
    if (typeof value !== 'object' || value === null || Object.keys(value).join() !== 'route') return 'unknown';
    const route = (value as { route: unknown }).route;
    return typeof route === 'string' && routes.includes(route) ? (route as ReviewRoute) : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const RouteReview = createGraph<State, {}, Parameters, ReviewRoute>({
  key: 'RouteReview',
  title: 'Route the review',
  init: (_destination, { review }) => ({ review, operationId: null, attempts: 0, route: 'unknown' }),
  state: {
    review: reduce.replace<string>(),
    operationId: reduce.replace<string | null>(),
    attempts: reduce.add(),
    route: reduce.replace<ReviewRoute>(),
  },
  entry: 'judge',
  nodes: {
    judge: operation(async (ctx, state) => {
      const handle = await ctx.runHeadlessAgent({ harness: 'codex', prompt: prompt(state.review) });
      return suspend({ update: { operationId: handle.operationId, attempts: 1 }, wait: wait.headlessAgent(handle) });
    }, { title: 'Judge the review' }),
  },
  edges: {
    afterJudge: edge({
      from: 'judge',
      to: ['judge', 'judged'],
      choose: (state, event) => {
        const result = eventGuards.requireHeadless(event, state.operationId!);
        const route = result.status === 'completed' ? parseRoute(result.output ?? '') : 'unknown';
        if (route === 'unknown' && state.attempts < 3) return { to: 'judge' };
        return { to: 'judged', update: { route } };
      },
    }),
  },
  outcomes: { judged: outcome({ kind: 'success', output: (state) => state.route }) },
});
```

## Review loop

A reviewer and a fixer iterate until the reviewer closes the loop. Built from the blocks above:

- **Two visible sessions, reused every round.** The first review spawns the reviewer, often with a review skill or command as a modifier; later rounds prompt the same session. The fixer is spawned by the workflow or is the launching agent (`origin.agentSessionId`), which the workflow never closes.
- **The reviewer ends the loop, not a counter.** Its prompt defines severities and an exact closing line ("No re-review needed.") to use only when nothing is open, and asks for a Human Escalation section every time, even if it says "No escalation."
- **Each round:** reviewer turn → read the reply → route it → fixer turn with the review → read the fixer's reply → reviewer turn with that reply, asked to verify each fix against the code, adjudicate each pushback, and review again.
- **One routing judgment serves the first review and every re-review**, so a first review can close the loop or escalate directly.
- **Routes:** `continue` sends the review to the fixer; `complete` finishes; `final-fixer` gives the fixer one last turn for the Nits with no re-review; `human-decision` sets feedback and waits on `userContinue` while the person settles it with the reviewer, then reads the reviewer's latest reply and sends it to the fixer without judging it again; `unknown` asks the person, then reads the reply again and re-routes.
- **Finish** closes the panes the workflow spawned. A failed or interrupted turn becomes a failure outcome that names the role.
- **Compose it in levels:** the root shows review ⇄ fix → finish; a review-round and a fix-round subgraph hold the turn, read and route nodes.

## Smaller shapes

- **Human-led step.** Spawn a session with a skill such as `brainstorming`, then `wait.userContinue` while the person drives it. After Continue, ask the same agent what is still open, classify the answer, and go back to the person until nothing is.
- **Check, then close.** After an agent writes an artifact, check it in an operation (exists, parses, validates). On failure, set feedback, log, and throw so the run fails with the pane still open; the person fixes it and presses Retry. Close the pane only after the check passes.
- **Many independent items.** Keep an index in state and give each item a fresh session that is checked, then closed.
- **Phases with checkpoints.** A long workflow runs design → walkthrough → approval → implement → document, with a [checkpoint](workflow-checkpoints.md) after each phase whose files a later rebuild needs.
