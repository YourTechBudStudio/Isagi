# Workflow style

How to write a workflow that is still correct after the third suspension, the first restart, and the
edit somebody makes to it next month.

[Workflows](workflows.md) covers the mechanics. This file covers the judgment. The rules here exist
because each one has a corresponding way to fail that the compiler will not catch for you unless you
arrange for it to.

## The user is reading. Write for them.

A running workflow has two audiences and two channels, and they are not interchangeable.

`ctx.setUiFeedback` is what the user watches while the run is live. It is the only thing they see.
`ctx.log` is what you read six weeks later when the run stalls and someone asks why.

**`phase` is a business stage, not a reducer node.** The user does not know what `await_headless`
means, and should never learn. They know that a reviewer is being asked, that the answer is coming
back, that the run is waiting for them.

```ts
// Wrong. Leaks the state machine, and names a node that six different judgments pass through.
await ctx.setUiFeedback({ kind: 'info', phase: state.phase, message: 'Working' });

// Right.
await ctx.setUiFeedback({
  kind: 'info',
  phase: 'Asking a reviewer',
  message: 'Checking the migration for data loss.',
});
```

If you take the advice in the next section and make `phase` a discriminated object, the wrong version
above stops compiling. That is the point of doing it.

**An error message names what actually failed.** The temptation is one string, reused at every
`fail` site, because writing ten different ones is work. Resist it. `Workflow setup failed`, emitted
from ten branches, tells the user nothing except that they have lost the afternoon.

```ts
// Wrong. Ten branches, one message, zero information.
await ctx.setUiFeedback({ kind: 'error', phase: state.phase, message: 'Workflow setup failed' });
return fail('Workflow setup failed.');

// Right. The user learns what broke; the log says which reviewer and why.
await ctx.setUiFeedback({
  kind: 'error',
  phase: 'Asking a reviewer',
  message: 'The reviewer finished without writing an answer.',
});
await ctx.log(
  'error',
  `Reviewer agentSessionId=${reviewer.agentSessionId} produced no assistant text.`,
);
return fail(`Reviewer session ${reviewer.agentSessionId} produced no assistant text.`);
```

**Feedback carries the story; logs carry the evidence.** Ids, paths, harness session ids, op ids,
parsed payloads - all of that goes in `ctx.log`, none of it in `setUiFeedback`. Conversely, a log line
that says only `failed` has thrown away the one thing it was for.

**Every branch emits both.** A `fail` with no preceding `setUiFeedback` shows the user a failed run
and no reason. A transition with no feedback leaves the run looking frozen while it works.

## Make bad states unrepresentable

### The default shape rots

The obvious state shape is a phase string plus optional fields for whatever the phases need:

```ts
// Wrong.
type State = {
  readonly phase: 'spawn_reviewer' | 'await_review' | 'paused' | 'done';
  readonly reviewer?: ReviewerPane | undefined;
  readonly pauseReason?: PauseReason | undefined;
  readonly awaiting?: Judgment | undefined;
};
```

Three things go wrong, and they compound.

Every optional field needs an accessor that throws, because every phase can see every field even
though only one phase ever sets it. You write `requireReviewer(state)`, `requireAwaiting(state)`, and
so on, and each one is a runtime check standing in for a type the compiler could have given you.

Every transition must reset the fields it is leaving behind. Miss one, and stale data rides into a
phase that has no business with it - a `pauseReason` from a pause two phases ago, an `awaiting`
judgment that already resolved.

And **`satisfies State` does not catch it.** This compiles:

```ts
// Compiles. Carries a stale reviewer and a stale pauseReason into 'done'.
return cont({ ...state, phase: 'done' } satisfies State);
```

The stale value is still a legal inhabitant of `ReviewerPane | undefined`. The type is satisfied. The
state machine is wrong.

Keep writing `satisfies State` on every `cont` and `suspend` payload - it catches a misspelled field
and a wrong type, which is worth having. Just do not mistake it for a check on staleness. It cannot
see the difference between a field you meant to carry forward and one you forgot to drop.

### Put per-phase data in the phase

```ts
// Right.
type Phase =
  | { readonly kind: 'spawn_reviewer' }
  | { readonly kind: 'await_review'; readonly reviewer: ReviewerPane }
  | { readonly kind: 'paused'; readonly reason: PauseReason }
  | { readonly kind: 'done' };

type State = {
  readonly stateVersion: 1;
  readonly question: string;
  readonly phase: Phase;
};
```

Now `{ ...state, phase: { kind: 'done' } }` cannot carry a stale reviewer, because `done` has nowhere
to put one. The reset is not something you remember to do; it is something you cannot avoid doing.
Inside `case 'await_review':`, `state.phase.reviewer` is non-optional. The accessor is gone.

Switch on `state.phase.kind`. An exhaustive switch over a discriminated union makes a new phase you
forgot to handle a compile error rather than a `fail` at three in the morning.

**Before you write a `require*` accessor, ask whether the field belongs in a phase variant.** Most of
them do, and the accessor disappears with them. What survives is the genuinely durable field -
something discovered once, early, and read by many phases afterwards, like a plan path or a count. For
those, an accessor that throws with the phase kind in its message is right:

```ts
function requirePlanPath(state: State): string {
  if (!state.planPath) throw new Error(`Phase ${state.phase.kind} requires planPath.`);
  return state.planPath;
}
```

### Two weaker alternatives, named honestly

If the discriminated phase does not fit - a workflow with many phases sharing one transient bag - the
next best thing is to put every transient field inside a single nested object, so a transition resets
one key instead of five. Understand what you are buying: **one greppable reset site, not enforcement.**
The compiler still will not tell you when you forget.

For workflows with a dozen phases, a small constructor per transition (`toAwaitReview(state, reviewer)`)
centralizes the same discipline. Also not enforcement. Also better than nothing.

### State is JSON

`state` round-trips through JSON on every suspension. A `Date` comes back a string. A `Map`, a `Set`,
or a class instance comes back a bare object with none of its methods. A field set to `undefined`
simply disappears - which is a real difference from a field set to `null`, and one that only shows up
after a restart.

Store primitives, plain objects, and arrays. Store an ISO string, not a `Date`.

### Narrow the event, fail loudly

`event` is `unknown` because the type system cannot know which wait you armed. Check it at every
resume, and fail with a message naming the phase when it is wrong. A workflow that assumes the event
shape and destructures it will not throw - it will read `undefined`, write a corrupt state, and carry
on.

```ts
case 'await_review': {
  if (!workflowEvent.isAgentTurnEnded(event)) {
    const reason = workflowEvent.isAgentTurnFailed(event) ? event.reason : 'an unexpected event';
    await ctx.log('error', `await_review resumed on ${reason}.`);
    return fail(`The reviewer turn did not end: ${reason}.`);
  }
  // ...
}
```

## Session discipline

**Re-pin from every `sendAgentPrompt` return.** The verb returns the `harnessSessionId` and `sentAt`
it actually used. If you keep an agent's identity in state and reuse it, overwrite those two fields
with what you just got back. A stale `harnessSessionId` makes the next conversation read point at a
stream that no longer exists, and the next wait point at a turn that will never come.

```ts
const sent = await ctx.sendAgentPrompt(reviewer.agentSessionId, prompt);
const pinned = { ...reviewer, harnessSessionId: sent.harnessSessionId, sentAt: sent.sentAt };
```

**Validate the launch context you actually need.** A workflow that drives the pane it was launched
from must reject a null `launchCtx.agentSessionId` in `validate`, with a message that tells the user
what to do:

```ts
if (launchCtx.agentSessionId === null || launchCtx.agentSessionId === undefined) {
  throw new Error('Start this workflow from the agent pane that should receive the review.');
}
```

Rejecting in `validate` costs the user nothing - no run row is created. Discovering it in `step`
costs them a failed run they have to clear.

**Close the panes you spawned. Never the one you started from.** Every `spawnAgentSession` returns a
`paneId`. A workflow that loops - a pane per phase, a pane per candidate - and never closes them
leaves the user with a surface full of dead agents. Close each one when its phase completes, not at
the end, or a long run accumulates the whole history on screen. The originating pane belongs to the
user; closing it, if it is the last pane, deletes their surface.

**One prompt per turn.** `sendAgentPrompt` rejects if that agent already has a turn in flight. This is
a guard, not a queue. If you find yourself wanting to send twice, you want to send once and suspend.

## Judgments

A judgment is a headless agent asked one closed question about some text: did this finish, does this
need clarification, is this a blocking objection. They are the joints of a workflow, and they are
where workflows break.

**Keep them in their own module.** Prompts, parsers, and result types together, away from the reducer.
The reducer should read as a state machine, not as a prompt library.

**One headless op per judgment, on a cheap model at low effort.** A judgment is a classification, not
an investigation. If a judgment needs a strong model to be reliable, the question is too broad - split
it.

**Prompt and parser move in lockstep.** The prompt states the exact JSON object it wants; the parser
validates the exact key set it stated. Change one, change the other, in the same edit.

This prose-JSON discipline is a workaround, not a preference. Headless harness runs are CLI
invocations - there is no structured-output or tool-calling API to constrain the response, so the
constraint has to live in the prompt and be enforced on the way back in.

```ts
// The prompt says exactly this, and nothing else.
`Decide whether the reviewer raised a blocking objection.

Latest reviewer response:
${reviewText}

Return exactly one JSON object with exactly this field:
{"blocking": false}

Rules:
- Blocking means the reviewer says work must stop until a human decides.
- Caveats, suggestions, and warnings without a stop condition are not blocking.
- Do not include confidence, commentary, markdown, or extra JSON fields.`;
```

```ts
// The parser accepts exactly that, and nothing else.
function parseBlocking(output: string): boolean {
  const first = output.indexOf('{');
  const last = output.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('Judgment output contained no JSON object.');
  const value: unknown = JSON.parse(output.slice(first, last + 1));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Judgment output was not a JSON object.');
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'blocking') {
    throw new Error(`Judgment must return exactly one field, blocking. Got: ${keys.join(', ')}.`);
  }
  const blocking = (value as { readonly blocking: unknown }).blocking;
  if (typeof blocking !== 'boolean') throw new Error('Judgment field blocking must be boolean.');
  return blocking;
}
```

Slicing from the first `{` to the last `}` tolerates a model that wraps its answer in a fence or a
sentence. It does not tolerate a model that answers with two objects or with prose containing braces.
That is intentional: an exact key-set check turns a chatty model into a loud failure instead of a
quiet misread. A judgment that silently parses `{"blocking": false, "confidence": 0.6}` as `false` is
worse than one that fails.

**When a judgment fails, say which one, and keep the output.** The raw text is the only evidence of
what the model actually did.

```ts
await ctx.log('error', `Judgment "blocking" failed to parse: ${message}`);
await ctx.log('error', `Raw output: ${rawOutput}`);
```

## Prompting agents from a workflow

An agent driven by a workflow has no user to ask. Whatever it needs must be in the prompt, and
whatever it produces must be usable without a follow-up. That single constraint generates most of what
follows.

### The shared core

**Make the first prompt self-contained.** There is no second chance to add context. State the goal,
the inputs, the constraints, and what the finished thing looks like.

**State explicit success criteria and stop conditions.** "Review this migration" has no end. "Review
this migration and report every statement that can lose data; if there are none, say so explicitly"
does.

**Reserve MUST and NEVER for real invariants.** If everything is a MUST, nothing is. For the rest, use
conditional decision rules: _if the plan is ambiguous, ask for the ambiguity to be resolved rather than
guessing._ Rules that describe a decision are followed; rules that shout are averaged.

**Give the rule and the reason.** "Do not modify files - another agent is editing them concurrently"
survives contact with a situation you did not anticipate. "Do not modify files" does not.

**Use one term for one thing.** If the prompt says "phase" in one paragraph and "step" in the next for
the same concept, the agent will decide they differ, and act on the difference.

**Give the agent something it can check.** A command to run, a file to read back, an assertion to make.
An agent that can verify its own work usually does.

**Frame the work as autonomous, and say so.** This one is functional, not stylistic. A mid-workflow
agent that ends its turn with a clarifying question is talking to nobody: the turn ends, the wait
resolves, and your reducer receives a question where it expected an answer. For a headless judgment it
is worse - the output is prose, the parser throws, the run fails. Tell the agent it is running
unattended, that no one will answer, and what to do when it is uncertain: pick the most reasonable
interpretation and state the assumption, or return the shape that means "I could not decide."

### Per-model tendencies

Model behavior moves. These are working tendencies of current-generation models as of the Isagi
release that generated this file, not documented API behavior. Treat them as defaults to try, not
facts to rely on. When a model is not named here, start from the shared core.

**GPT-5.x family**

- Responds well to an explicit skeleton: goal, context, constraints, done-when.
- Follows instructions literally, which makes contradictions expensive. Two rules that conflict cost
  more than one vague rule.
- Modest reasoning effort is usually right for a judgment. High effort on a boolean classification
  spends time without improving agreement.

**Claude family**

- Needs less prescription than instinct suggests. Over-specifying a procedure tends to make output
  worse, not better.
- Steer length explicitly when you need it short; the default is thorough.
- Prefers positive instructions. "Return only the JSON object" beats "Do not add explanation." Skip
  ALL-CAPS and threat framing; neither improves compliance.
