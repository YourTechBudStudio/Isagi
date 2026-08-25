import { Context, Data, Effect, Schema } from 'effect';

import type {
  CommandPortPathConfig,
  WorktreeCommandPortConfig,
} from '../project-config/project-config.schema.js';

// The resolved-port vocabulary shared by persistence, launch, and projection.
//
// A resolved entry is a *source fact* about one command incarnation: which port
// it actually got, and — for an allocated entry — the environment variable the
// value was injected under. `envVar` doubles as the allocation identity a later
// launch matches its preference against, so a fixed entry carries null: there is
// nothing to remember for a port the user already fixed.
//
// Paths are stored exactly as declared. URLs are composed at read time
// (`commands.summary.ts`), so the durable row never holds a derived value.
export interface ResolvedPortEntry {
  readonly envVar: string | null;
  readonly port: number;
  readonly paths: readonly CommandPortPathConfig[];
}

// The decode boundary for the persisted snapshot. Historical or hand-edited rows
// are outside the model's control, so the repository folds a decode failure into
// the contract's honest `null` rather than failing the read.
export const resolvedPortsSnapshotSchema = Schema.Array(
  Schema.Struct({
    envVar: Schema.NullOr(Schema.String.pipe(Schema.minLength(1))),
    port: Schema.Number.pipe(Schema.int(), Schema.between(1, 65_535)),
    paths: Schema.Array(
      Schema.Struct({
        label: Schema.String.pipe(Schema.minLength(1)),
        path: Schema.String.pipe(Schema.minLength(1)),
      }),
    ),
  }),
);

// ---------------------------------------------------------------------------
// Allocation policy
// ---------------------------------------------------------------------------

// The bound on how many times one allocated entry will re-ask the operating
// system after being handed a port this same resolution already claimed.
//
// Five is deliberately small. The architecture chose a bounded best-effort
// operation and accepts that allocation can fail while free ports remain: the
// alternative — looping until the OS cooperates — trades a rare, honest,
// diagnosable failure for an unbounded stall inside a command launch. Raising
// this bound would not make the operation correct, only slower to admit
// defeat.
const maxOsAssignReasks = 5;

// The expected failure of resolution. `detail` is runtime-authored and safe to
// persist and display: it names the endpoint's environment variable (a
// config-authored identifier) and may embed `describeOperationalCause` output,
// which is the same trust posture `env_invalid` and `pty_launch_failed` take.
export class CommandPortAllocationError extends Data.TaggedError('CommandPortAllocationError')<{
  readonly detail: string;
}> {}

export interface CommandPortProbeService {
  /**
   * Best-effort availability check. True only when a loopback bind of the port
   * succeeded *and* its listener finished closing — a port is never reported
   * inactive while this call might still hold it, because the caller's next act
   * is to hand it to a process that must bind it.
   *
   * Exposes no expected failure: a bind refusal is the ordinary "in use"
   * answer, and every other operational fault folds to `false` so that a probe
   * fault on a remembered port cannot kill a launch a fresh assignment could
   * still serve. Interruption is preserved, and genuine defects stay defects.
   */
  readonly probeInactive: (port: number) => Effect.Effect<boolean>;
  /**
   * Bind `127.0.0.1:0`, read the port the operating system assigned, and return
   * it only once the listener has finished closing. Bind and close failures are
   * both `CommandPortAllocationError`: a port that may still be held is never
   * handed out.
   */
  readonly obtainEphemeralPort: Effect.Effect<number, CommandPortAllocationError>;
}

export const CommandPortProbe =
  Context.GenericTag<CommandPortProbeService>('isagi/CommandPortProbe');

/**
 * Resolve one command's declared ports into the snapshot its incarnation will
 * receive.
 *
 * The invariant that shapes the whole function is **order-independent
 * exclusion**: two endpoints of one command must never resolve to the same
 * port, no matter how the entries are ordered in the file. So every fixed
 * declaration is excluded before any allocated entry is considered — otherwise
 * an allocated entry appearing first could reuse a port that a fixed entry
 * further down the file has already claimed.
 *
 * Pure policy over an injected probe: the only IO is the probe's, which is what
 * lets this be tested without sockets.
 */
export function resolveCommandPorts(input: {
  readonly declared: readonly WorktreeCommandPortConfig[];
  readonly remembered: readonly ResolvedPortEntry[] | null;
  readonly probe: CommandPortProbeService;
}): Effect.Effect<ResolvedPortEntry[], CommandPortAllocationError> {
  return Effect.gen(function* () {
    const { declared, remembered, probe } = input;

    const excluded = new Set<number>();
    for (const entry of declared) {
      if (entry.kind === 'fixed') excluded.add(entry.port);
    }

    // Declaration order is preserved in the output: it is the order the
    // persisted snapshot keeps and the order the UI presents.
    const resolved: ResolvedPortEntry[] = [];
    for (const entry of declared) {
      if (entry.kind === 'fixed') {
        // Never probed. The user fixed this port, so its availability is
        // theirs to own; a probe here could only produce an opinion the
        // resolver is not allowed to act on.
        resolved.push({ envVar: null, port: entry.port, paths: entry.paths });
        continue;
      }
      const port = yield* resolveAllocatedPort({
        envVar: entry.envVar,
        remembered,
        excluded,
        probe,
      });
      excluded.add(port);
      resolved.push({ envVar: entry.envVar, port, paths: entry.paths });
    }
    return resolved;
  });
}

function resolveAllocatedPort(input: {
  readonly envVar: string;
  readonly remembered: readonly ResolvedPortEntry[] | null;
  readonly excluded: ReadonlySet<number>;
  readonly probe: CommandPortProbeService;
}) {
  return Effect.gen(function* () {
    const { envVar, remembered, excluded, probe } = input;

    // First match by `envVar`. Config validation makes duplicate declarations
    // impossible, and a malformed persisted snapshot has already degraded to
    // `null` before reaching here, so there is no ambiguity for this function
    // to resolve. A fixed remembered entry carries `envVar: null` and can never
    // match a declaration's non-empty variable name.
    const previous = remembered?.find((candidate) => candidate.envVar === envVar) ?? null;
    if (previous && !excluded.has(previous.port) && (yield* probe.probeInactive(previous.port))) {
      return previous.port;
    }

    for (let attempt = 0; attempt < maxOsAssignReasks; attempt += 1) {
      const candidate = yield* probe.obtainEphemeralPort.pipe(
        // The adapter knows the operational cause but not which endpoint asked;
        // this is the layer that knows the endpoint, so it composes the text a
        // user will read.
        Effect.mapError(
          (error) =>
            new CommandPortAllocationError({
              detail: `Could not allocate a port for ${envVar}: ${error.detail}`,
            }),
        ),
      );
      if (!excluded.has(candidate)) return candidate;
    }

    // Policy failure, not adapter failure: the operating system answered every
    // time, and each answer was a port this same command had already taken.
    return yield* Effect.fail(
      new CommandPortAllocationError({
        detail: `Could not allocate a port for ${envVar}: the operating system kept returning ports already assigned to this command.`,
      }),
    );
  });
}

/**
 * The environment variables a resolved snapshot injects into its command.
 *
 * Pure and policy-free: allocated entries only, decimal port strings, no
 * collision or precedence opinion. Config validation already rejects an
 * `envVar` that collides with the command's explicit `env`, and the launch
 * site owns where this record sits in the merge order.
 */
export function portEnvInjections(entries: readonly ResolvedPortEntry[]): NodeJS.ProcessEnv {
  const injections: NodeJS.ProcessEnv = {};
  for (const entry of entries) {
    if (entry.envVar !== null) injections[entry.envVar] = String(entry.port);
  }
  return injections;
}
