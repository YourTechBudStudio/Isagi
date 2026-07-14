# Author workflows

Use this reference to create, modify, or review a workflow package and verify the completed changes. Do not use it to launch or manage workflow runs.

## Procedure

1. Read every file in the bundled [`minimal-workflow/`](minimal-workflow/) scaffold before editing the target workflow. For a new workflow, copy the scaffold. For an existing workflow, preserve its authored code and use the scaffold to repair or update its package structure.
2. Match the scaffold's exact package contract: `@yourtechbudstudio/isagi-workflow-sdk@{{SDK_VERSION}}` in `dependencies`, plus `@yourtechbudstudio/isagi-workflow-verifier@{{VERIFIER_VERSION}}` and `esbuild@{{BUILDER_VERSION}}` in `devDependencies`. Preserve the scaffold's `build` and `verify` scripts.
3. Prepare the package dependencies using the target repository's existing conventions.
4. Read `node_modules/@yourtechbudstudio/isagi-workflow-sdk/dist/index.d.ts` completely. Treat those declarations as the authority for workflow types, constructors, helpers, and signatures. Do not recreate the SDK API from this reference.
5. Implement the user's requested workflow changes and tests using the conventions below.
6. After all authoring changes are complete, run the package's `typecheck` and `test` scripts and fix every failure. The verifier does not run them; typecheck and tests are the author's quality gate.
7. Then run the package's `build` script and its `verify` script. The verifier never compiles on the author's behalf; it checks that the Isagi runtime will be able to load the existing `dist/index.js` build — exact pins, symlink-free sources, and a loadable workflow export. Fix failures, rebuild, and rerun verification until both commands succeed; the runtime refuses to load a build whose sources changed after verification.

## Definition and state

- Treat `step(ctx, state, event)` as a reducer over durable stages. Keep persisted state JSON-serializable: primitives, plain objects, arrays, and ISO strings, not `Date`, `Map`, `Set`, class instances, or provider-specific objects.
- Make `state.stage` a discriminated union and make `step` one exhaustive switch over `state.stage.kind`. Prefer stage names that describe the wait, such as `await_review`, over a generic `await_headless` plus a second discriminator.
- Keep data needed by one stage in that stage variant. Keep durable facts shared across stages at the top level. Before adding a `require*` accessor or optional field, check whether the value belongs in a narrower stage.
- Use `satisfies State` on transition payloads to catch shape drift. Do not treat it as protection against stale optional data; design the union so stale data cannot exist.
- Keep `state.stage` for internal control flow, `setUiFeedback({ phase })` for the status the user reads, and a separate field such as `currentPhase` for a workflow's own domain phase.
- Keep `command` independent of optional pane or agent-session context. Use `validate` to reject bad launch inputs and `init` to copy every launch fact needed later into the initial state.

```ts
type Stage =
  | { readonly kind: "spawn_reviewer" }
  | { readonly kind: "await_review"; readonly reviewer: Reviewer };

type State = {
  readonly stateVersion: 1;
  readonly stage: Stage;
};
```

## Transitions, waits, and sessions

- Return only through the SDK result constructors and build waits only with `wait.*`. A wait is a suspended reducer result, not a Promise to await.
- Pass the target returned by `spawnAgentSession` or `sendAgentPrompt` directly to `wait.agentTurn`. Persist only stable identifiers needed by later stages.
- Treat `event` as `unknown`. Narrow every resumed event with the SDK event helpers before reading it, and fail clearly on an unexpected or failed result.
- Inspect every joined result from `wait.workflow` and `wait.headlessAgent`. A failed child operation still satisfies the wait and must be handled by the resumed stage.
- Treat operational calls as replayable. Do not make correctness depend on spawning a session, sending a prompt, or starting a child workflow exactly once.
- Send one prompt per agent turn. Do not reset, resume, or switch the underlying harness conversation while a workflow-controlled turn is active.
- Keep provider and harness-session identity out of workflow state. Durable `agentSessionId` and `paneId` values are sufficient.
- Close panes created by the workflow when they are no longer needed. Never close the pane from which the workflow was launched.

## Prompt input and modifiers

Every agent-input verb — `spawnAgentSession`, `sendAgentPrompt`, and `runHeadlessAgent` — accepts an optional `prompt` and optional `modifiers`. Treat the installed `dist/index.d.ts` as the authority for their exact shapes; this section covers only semantics and per-harness rendering.

- A modifier is a semantic request: `{ kind: 'skill', name }` or `{ kind: 'command', name }`. Provide a plain asset name, not a rendered token — no leading `/` or `$`, and no whitespace or Unicode control or format characters. Isagi renders the harness-native token for you.
- Skills stack in caller order with no count limit. Whether a harness actually applies several skills at once is the harness's behavior, not Isagi's guarantee; stacking beyond a harness's native support is your choice as the author.
- A command must be the only modifier. You cannot stack commands or mix a command with skills.
- `prompt` is optional. A whitespace-only prompt is treated as absent; a non-whitespace prompt is preserved as-is by the renderer (not trimmed), though interactive submission normalizes CRLF line endings to LF. An input with no modifier and no non-whitespace prompt is rejected and fails the step — before `spawnAgentSession` or `runHeadlessAgent` create any resources, and before `sendAgentPrompt` writes to its existing session.
- Rendered tokens keep your order, separated by one space, and a present prompt is appended after one space.

Isagi guarantees deterministic rendering and submission. It does not check that a skill or command exists, detect name collisions, or verify that the harness will interpret it. Availability and native interpretation remain the harness's responsibility.

| Harness    | `{ kind: 'skill', name }` | `{ kind: 'command', name }` |
| ---------- | ------------------------- | --------------------------- |
| `pi`       | `/skill:<name>`           | `/<name>`                   |
| `opencode` | `/<name>`                 | `/<name>`                   |
| `claude`   | `/<name>`                 | `/<name>`                   |
| `codex`    | `$<name>`                 | `$<name>`                   |

Pi is the only harness that renders a skill differently from a command. Claude and Codex have no native command concept, so a command modifier renders the same token as a skill on those harnesses; choose `pi` or `opencode` when you need first-class command syntax. This is generic per-harness rendering, not detection of a specific name.

```ts
// plain prompt
await ctx.sendAgentPrompt({ agentSessionId, prompt: "Review the diff." });
// modifier-only command
await ctx.spawnAgentSession({ harness: "pi", modifiers: [{ kind: "command", name: "isagi-docs" }] });
// stacked skills with a prompt
await ctx.spawnAgentSession({
  harness: "claude",
  modifiers: [
    { kind: "skill", name: "plan" },
    { kind: "skill", name: "review" },
  ],
  prompt: "Implement phase 2.",
});
// object-form send
await ctx.sendAgentPrompt({
  agentSessionId,
  modifiers: [{ kind: "skill", name: "review" }],
  prompt: "Focus on auth.",
});
```

Use command modifiers only for harness-native prompt templates or commands you expect to start an agent turn, and pass the spawn or send result to `wait.agentTurn` as usual. UI-only commands such as `/help`, `/settings`, or `/model` do not start a turn and are outside this contract; do not wait on one. Headless OpenCode is a further caveat: its plain `run` transport may treat slash-looking text as ordinary model prompt text rather than invoking a native command, though Isagi still renders and submits the text you asked for.

## Conversations and judgments

- Treat conversation history as role-tagged messages. A turn may contain several assistant messages; collect the latest complete assistant turn instead of assuming the final message is the full reply.
- Orchestrated agents are non-deterministic and may skip, combine, or complete steps beyond the phase they were given.
- Define one reusable judgment contract — its prompt, exact parser, and result type — for each orchestrated agent session, and apply it after every relevant turn instead of creating phase-specific judgments for the same agent.
- Give that contract every workflow-relevant outcome the agent could produce. The current workflow phase is input to the judgment, but must not restrict its possible answers; let deterministic reducer code map each tagged outcome to continuing, jumping to another phase, finishing, requesting user input, or failing clearly. Collapse responses that take the same route and state precedence when outcomes overlap.
- Treat a judgment prompt and parser as one contract. Request one exact JSON object; validate its key set and value domain; reject extra fields; log the judgment name and raw output on parse failure.
- Tell workflow-driven agents they are unattended. Give them the goal, inputs, constraints, success criteria, stop conditions, and a path forward when uncertain. Do not make progress depend on a user answering mid-turn.

## Feedback and diagnostics

- Update `setUiFeedback` when the business-facing phase changes, not for every internal transition. Keep the copy concise, specific, and useful to the user's next action.
- Use `ctx.log` for evidence such as identifiers, paths, operation ids, parsed payloads, and failure causes. Before returning `fail`, set specific user feedback and log the diagnostic context.
- Do not report uncertain, partial, or failed work as success.

## Package and bundle conventions

- Default-export `defineWorkflow(...)` from `src/index.ts`. Use relative imports with `.js` extensions under NodeNext TypeScript.
- Keep the static import graph resolvable from declared dependencies. Do not rely on files that exist only elsewhere on the author's machine.
- Keep the bundle to one Node ESM artifact: no native addons, opaque dynamic imports, code splitting, or emitted side assets. Run native or external work in a process launched at workflow runtime.
- Keep tests hermetic. Exercise representative transitions, waits, success, and failure outcomes without depending on a live Isagi runtime or agent provider. For each judgment contract, cover every tagged judgment outcome and its resulting route, including non-linear jumps.

Typecheck and tests are the author's quality gate; build followed by verification is the completion gate for runtime compatibility. Report the commands that passed; do not claim the workflow is ready when any of them failed or was skipped.
