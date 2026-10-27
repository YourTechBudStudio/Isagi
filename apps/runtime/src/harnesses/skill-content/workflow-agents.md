# Agents in workflows

Exact capability, result and prompt types are in the installed `operations.d.ts` and `launch.d.ts`. Worked shapes are in [Recipes](workflow-recipes.md).

## Visible sessions do the work

Use interactive agent sessions (`spawnAgentSession`, `sendAgentPrompt`, then `wait.agentTurn`) for all real work: writing, implementing, reviewing, fixing, committing. They run in panes the person can watch, and when a turn goes wrong the person can step in and finish it by hand.

Use `runHeadlessAgent` only for classification: a short, unattended judgment over text the workflow hands it, such as routing a reply as `approved`, `revise` or `needs-human`. A headless agent should not change files or run tools with external effects. When a check can be deterministic (a file exists, a schema validates), check it in an operation instead of asking a model.

## Sessions

| Need | Do |
| --- | --- |
| A new agent | `spawnAgentSession` with a harness, an optional model and effort, and the first prompt. Persist the returned `agentSessionId` and `paneId`. |
| Further turns in the same context | `sendAgentPrompt` to the stored `agentSessionId`. Reuse a session across loop rounds so each role keeps its context and the person sees one pane per role. |
| Clean context per item | Spawn a fresh session per item and close its pane once its result checks out. |
| The agent the workflow was launched from | Read `origin.agentSessionId` in `parse`. The workflow does not own its pane; never close it. |
| A step the person drives | Spawn the session, then `wait.userContinue` while the person works with it. |

Close panes the workflow created once their work is accepted ([check, then close](workflow-recipes.md#smaller-shapes)); leave a pane open when its step fails so the person can look. Persist Isagi handles, never provider-native session IDs.

## Which turn answers a wait

Send one prompt per controlled turn and let it settle before the next prompt or a harness conversation reset or switch. The latest turn that started at or after the prompt answers the wait: while it runs the wait keeps waiting, an ended turn delivers `ended`, a failed one `failed`, and a dead session `interrupted` with `session_died`. A newer turn replaces an older one, so if the person finishes the agent by hand after a failure, re-arming `wait.agentTurn` on the same target picks up their turn, also on Resume and Retry. Re-arming without a new turn finds the same failed turn again. The prompt time comes from the runtime's clock and the turn time from the harness's, so a turn within clock skew of the prompt can be misread.

`sendAgentPrompt` types into the agent's terminal, so it fails while the pane is in Fluidcast mode; switch the pane back to the terminal and Retry. A prompt sent before the pane switched away keeps waiting; cancel the run to get out.

Isagi records every spawn, prompt, headless launch and pane close with its full request, plus the agent's last reply when its turn is delivered, so a run's dialogue is readable later without author code.

## Prompts

Give each agent a goal, its inputs (paths, prior review), constraints, acceptance criteria and a closing signal you can classify, such as an exact final line. Tell unattended or long-running agents to finish and state any blocking question in their reply rather than asking mid-turn; put the human decision in a graph wait. Keep authorization boundaries explicit when work can have external effects.

A classification prompt states that it is an unattended routing judgment, includes the text to judge, lists the routes in precedence order, and asks for an exact JSON shape. Classify what the reply says rather than the stage you expect: agents skip ahead, repeat work or raise a decision early, so every route stays valid on every call. Use one classifier with one route set for a role wherever its replies are judged, and route every outcome from every point; don't build a narrower classifier for an early stage. Parse it strictly (exact keys and allowed values), log parse failures with context, and treat an unparseable or failed judgment as a routable result. Read the text to judge in an earlier node with [`latestAssistantTurn`](workflow-recipes.md#read-a-reply); no reply is a failure, not success.

## Prompt modifiers

`spawnAgentSession`, `sendAgentPrompt` and `runHeadlessAgent` accept `modifiers` next to `prompt`; at least one non-blank prompt or modifier is required. Use plain names without a leading `/` or `$`, whitespace or control characters; Isagi renders the native token. Skills stack in order; a command must be the only modifier and must start an agent turn, so UI-only commands like `/help` or `/model` never satisfy a turn wait. Isagi does not check that the skill or command exists. Headless OpenCode may treat slash-looking text as plain prompt text.

```ts
import type { WorkflowPromptInput } from '@yourtechbudstudio/isagi-workflow-sdk';

export const reviewInput = {
  modifiers: [{ kind: 'skill', name: 'review' }],
  prompt: 'Review the diff against the acceptance criteria.',
} satisfies WorkflowPromptInput;
```

Use `setUiFeedback` when the business-facing phase changes, not at every internal step. Before failing deliberately or asking the person, explain the problem and the next action in feedback and `log` the details; edges cannot call either.
