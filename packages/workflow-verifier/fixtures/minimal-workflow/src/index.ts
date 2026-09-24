import {
  complete,
  createGraph,
  defineWorkflow,
  edge,
  operation,
  outcome,
  reduce,
  suspend,
  wait,
} from '@yourtechbudstudio/isagi-workflow-sdk';

// A minimal, harness-free workflow. It reads one text input, pauses for the user to continue,
// then completes with that input. It exists to demonstrate the shape of the model — a
// parameterized graph, reducer-owned state, an operation node that suspends on a wait, one
// router per node, and a terminal outcome — not to do useful work. Richer patterns
// (spawnAgentSession, agent-turn waits, headless judgments, nested graphs) are covered in the
// Isagi Docs workflow guide.

type State = {
  readonly note: string;
  readonly acknowledged: boolean;
};

type Inputs = {
  readonly note?: unknown;
};

type Parameters = Inputs;

// Exported so the package's own tests can exercise the graph directly. The runtime only ever
// reads the default export.
export const MinimalGraph = createGraph<State, {}, Parameters, { readonly note: string }>({
  key: 'Minimal',
  title: 'Minimal workflow',
  intent: 'business',
  // init is synchronous and runs once per graph invocation. It never runs again to migrate state.
  init: (_destination, parameters): State => ({
    note: parseNote(parameters.note),
    acknowledged: false,
  }),
  // Every state field declares how an update is applied. Omitting a field leaves it unchanged.
  state: {
    note: reduce.replace<string>(),
    acknowledged: reduce.replace<boolean>(),
  },
  entry: 'askForAck',
  nodes: {
    // The callback suspends on a user-continue wait. It runs again only if this segment is
    // repaired; the wait itself is durable, so a restart does not re-ask the person.
    askForAck: operation(async () => suspend({ wait: wait.userContinue('Continue') }), {
      title: 'Wait for acknowledgement',
    }),
    recordAck: operation(async () => complete({ update: { acknowledged: true } }), {
      title: 'Record the acknowledgement',
    }),
  },
  edges: {
    // Routers are pure and synchronous, and must declare every destination they may choose.
    fromAskForAck: edge({
      from: 'askForAck',
      to: ['recordAck'],
      choose: () => ({ to: 'recordAck' }),
    }),
    fromRecordAck: edge({
      from: 'recordAck',
      to: ['acknowledged'],
      choose: () => ({ to: 'acknowledged' }),
    }),
  },
  outcomes: {
    acknowledged: outcome({
      kind: 'success',
      title: 'Acknowledged',
      output: (state) => ({ note: state.note }),
    }),
  },
});

// `environment` is optional. Omitting it places the run in the current worktree and surface; declare
// it to choose a different one.
export default defineWorkflow<Inputs, { readonly note: string }>({
  command: () => ({
    title: 'Minimal workflow',
    description: 'A starter workflow that pauses for the user, then completes.',
    inputs: [
      {
        kind: 'text',
        key: 'note',
        label: 'Note echoed back when the run completes',
        default: 'hello',
      },
    ],
  }),
  // Validated launch inputs become the root graph's parameters with no further mapping.
  validate: (_origin, inputs) => {
    parseNote(inputs.note);
  },
  graph: MinimalGraph,
});

function parseNote(value: unknown): string {
  if (value === undefined) return 'hello';
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error('note must be a non-empty string.');
}
