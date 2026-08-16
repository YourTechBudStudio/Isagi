import {
  defineWorkflow,
  done,
  event as workflowEvent,
  suspend,
  wait,
} from "@yourtechbudstudio/isagi-workflow-sdk";

// A minimal, harness-free workflow. It reads one text input, pauses for the user to
// continue, then completes with that input. It exists to demonstrate the durable model —
// JSON-serializable state, a suspension, event narrowing, and a terminal result — not to do
// useful work. Richer patterns (spawnAgentSession, agent-turn waits, headless judgments) are
// covered in the Isagi Docs workflow guide.

type Stage = { readonly kind: "await_ack" };

type State = {
  readonly stateVersion: 1;
  readonly note: string;
  readonly stage: Stage;
};

type Variables = {
  readonly note?: unknown;
};

export default defineWorkflow<State, Variables>({
  command: () => ({
    title: "Minimal workflow",
    description: "A starter workflow that pauses for the user, then completes.",
    inputs: [
      {
        kind: "text",
        key: "note",
        label: "Note echoed back when the run completes",
        default: "hello",
      },
    ],
  }),
  validate: (_launchCtx, variables) => {
    parseNote(variables.note);
  },
  init: (_launchCtx, variables): State => ({
    stateVersion: 1,
    note: parseNote(variables.note),
    stage: { kind: "await_ack" },
  }),
  step: async (_ctx, state, incoming) => {
    switch (state.stage.kind) {
      case "await_ack":
        // First entry carries no user-continue event, so suspend and wait for one; the
        // resume delivers a user_continue event, which completes the run.
        return workflowEvent.isUserContinue(incoming)
          ? done({ note: state.note })
          : suspend(state, wait.userContinue());
      default:
        return assertNever(state.stage.kind);
    }
  },
});

function parseNote(value: unknown): string {
  if (value === undefined) return "hello";
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error("note must be a non-empty string.");
}

function assertNever(value: never): never {
  throw new Error(`Unsupported stage: ${String(value)}`);
}
