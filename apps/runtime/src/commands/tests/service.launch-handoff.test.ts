import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { Cause, Effect, Exit, Fiber } from 'effect';

import { DatabaseError } from '../../persistence/index.js';
import { type ResolvedPortEntry } from '../commands.ports.js';
import { type CommandRunRow, type CommandStateRow } from '../commands.repository.js';
import {
  commandLaunchAllocation,
  commandPortProbe,
  recordingEventBus,
  commandRun,
  commandState,
  createFixture,
  fakePtyProcessRow,
  runCommandServiceEffect,
  writeConfig,
  type CommandRepositoryOptions,
} from './test-support.js';

/**
 * The ownership handoff: a command's run is linked to its PTY row *before* any
 * backend process exists, and every exit after the run is created either
 * completes that run or hands it to a defined recovery. These tests drive the
 * orderings that used to be unobservable — immediate exits, cancellation, and
 * persistence faults at each step — through repository hooks rather than clocks.
 *
 * The single-link invariant is asserted after each scenario: a command state's
 * pointer is null or equal to the latest retained run's PTY link, so at most one
 * nonterminal incarnation is ever linked in model.
 */

const config = `
commands:
  - name: dev
    command: pnpm dev
`;

interface StateTransition {
  readonly commandName: string;
  readonly status: string;
  readonly activePtyProcessId: number | null;
  // Present only when the transition call named it. Its absence is the evidence
  // that a write preserved the resolved snapshot rather than rewriting it.
  readonly resolvedPorts?: readonly ResolvedPortEntry[] | undefined;
}

interface Harness {
  readonly runs: CommandRunRow[];
  // The durable state is observed through its transitions: the fake repository
  // owns the rows, and what these tests care about is exactly what was written.
  readonly transitions: StateTransition[];
  // The repository's own rows as they stood after the launch settled, for the
  // questions transitions cannot answer — chiefly "did a failed attempt leave
  // the previous resolution alone?", which is about what survived rather than
  // what was written. Sourced through `afterListStates` because the fake
  // repository copies its seed, so the array a test seeds is never the array the
  // service mutates.
  readonly states: CommandStateRow[];
  readonly published: Array<{ readonly commandName: string; readonly status: string }>;
  readonly calls: string[];
  // The environment the launch handed the PTY layer, captured at the boundary
  // where precedence stops being theoretical.
  readonly envOverrides: Array<NodeJS.ProcessEnv | undefined>;
}

/**
 * Runs one command launch against the fake repository, capturing durable rows,
 * state transitions, published `command_changed` events, and the order of the
 * allocation machine's stages.
 */
async function launch(
  options: {
    readonly seedState?: CommandStateRow | undefined;
    readonly ptyProcessId?: number | undefined;
    readonly start?: Effect.Effect<never> | undefined;
    // Interrupts the launch once `predicate` reports the fiber has reached the
    // point under test. No timers: the launch itself is what advances.
    readonly interruptWhen?: ((harness: Harness) => boolean) | undefined;
    // Replaces the portless default config when a test is about declared ports.
    readonly config?: string | undefined;
    // Extra files written into the worktree before the launch, so an env-file
    // precedence test can own its own fixture.
    readonly files?: Readonly<Record<string, string>> | undefined;
  } & Pick<
    CommandRepositoryOptions,
    | 'ptyProcess'
    | 'ptyProcessReadFault'
    | 'pruneOutcome'
    | 'transitionFault'
    | 'updateRunPtyOutcome'
    | 'finalizeFault'
    | 'runs'
    | 'portProbe'
  > = {},
) {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, options.config ?? config);
  for (const [name, contents] of Object.entries(options.files ?? {})) {
    writeFileSync(join(fixture.rootPath, name), contents);
  }
  const runs: CommandRunRow[] = options.runs ?? [];
  const seededStates: CommandStateRow[] = options.seedState ? [options.seedState] : [];
  const states: CommandStateRow[] = [];
  const transitions: StateTransition[] = [];
  const published: Harness['published'] = [];
  const calls: string[] = [];
  const envOverrides: Harness['envOverrides'] = [];
  const harness: Harness = { runs, transitions, states, published, calls, envOverrides };
  const ptyProcessId = options.ptyProcessId ?? 902;

  try {
    const outcome = await runCommandServiceEffect(
      fixture.rootPath,
      (service) =>
        Effect.gen(function* () {
          const launching = yield* Effect.fork(service.run({ worktreeId: 10, commandName: 'dev' }));
          if (options.interruptWhen) {
            yield* waitUntilEffect(() => options.interruptWhen!(harness));
            yield* Fiber.interrupt(launching);
          }
          // The recording bus publishes synchronously, and the interruption
          // finalizer is uninterruptible and runs before the fiber completes, so
          // awaiting the launch is enough: no settle window, and "nothing was
          // published" is a conclusive assertion rather than a hopeful one.
          const settled = yield* Fiber.await(launching);
          // One listing purely to pull the repository's own rows out through
          // `afterListStates`. It runs after the launch has fully settled, so
          // what it captures is the durable outcome.
          yield* service.listForWorktree(10).pipe(Effect.either);
          return settled;
        }),
      {
        eventBus: recordingEventBus(published),
        states: seededStates,
        runs,
        ...(options.ptyProcess === undefined ? {} : { ptyProcess: options.ptyProcess }),
        ...(options.ptyProcessReadFault
          ? { ptyProcessReadFault: options.ptyProcessReadFault }
          : {}),
        ...(options.pruneOutcome ? { pruneOutcome: options.pruneOutcome } : {}),
        ...(options.transitionFault ? { transitionFault: options.transitionFault } : {}),
        ...(options.updateRunPtyOutcome
          ? { updateRunPtyOutcome: options.updateRunPtyOutcome }
          : {}),
        ...(options.finalizeFault ? { finalizeFault: options.finalizeFault } : {}),
        ...(options.portProbe ? { portProbe: options.portProbe } : {}),
        afterListStates: (rows) => {
          states.length = 0;
          states.push(...rows.map((row) => ({ ...row })));
        },
        onRunLinked: () => calls.push('link'),
        onTransition: (input) => transitions.push(input),
        pty: {
          allocateLaunch: (input) => (
            envOverrides.push(input.envOverrides),
            Effect.succeed(
              commandLaunchAllocation({
                ptyProcessId,
                cwd: fixture.rootPath,
                calls,
                ...(options.start ? { start: options.start } : {}),
              }),
            )
          ),
        },
      },
    );
    assertSingleLink(harness);
    return { ...harness, exit: outcome, ptyProcessId };
  } finally {
    fixture.cleanup();
  }
}

function waitUntilEffect(predicate: () => boolean) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }
    throw new Error('Timed out waiting for the launch to reach the point under test');
  });
}

/** The pointer is null, or it equals the latest retained run's PTY link. */
function assertSingleLink(harness: Harness) {
  const names = new Set(harness.transitions.map((transition) => transition.commandName));
  for (const name of names) {
    const last = harness.transitions.filter((transition) => transition.commandName === name).at(-1);
    if (!last || last.activePtyProcessId === null) continue;
    const latestRun = harness.runs.filter((run) => run.commandName === name).at(-1);
    assert.equal(
      last.activePtyProcessId,
      latestRun?.ptyProcessId,
      'state pointer must equal the latest run link',
    );
  }
}

function lastTransition(harness: Harness) {
  return harness.transitions.at(-1);
}

function launchFailure() {
  return new DatabaseError({ operation: 'create_pty_process_metadata', cause: new Error('nope') });
}

test('the run is linked to its PTY row before anything reaches a backend', async () => {
  const result = await launch();

  assert.deepEqual(result.calls, ['allocate', 'link', 'start']);
  assert.equal(result.runs.at(-1)?.ptyProcessId, result.ptyProcessId);
  assert.deepEqual(result.transitions, [
    // The launch-in-progress marker, then the completed handoff. The marker is
    // the only transition that names `resolvedPorts` — this command declares
    // none, so it supersedes with `[]` — and the handoff omits the field, which
    // is how every non-marker write preserves the snapshot by construction.
    { commandName: 'dev', status: 'running', activePtyProcessId: null, resolvedPorts: [] },
    { commandName: 'dev', status: 'running', activePtyProcessId: 902 },
  ]);
  // The marker publishes nothing; only the completed handoff announces.
  assert.deepEqual(result.published, [{ commandName: 'dev', status: 'running' }]);
});

test('a post-start row still starting is owned and left for the poller to heal', async () => {
  const result = await launch({ ptyProcess: fakePtyProcessRow({ id: 902, status: 'starting' }) });

  assert.deepEqual(lastTransition(result), {
    commandName: 'dev',
    status: 'running',
    activePtyProcessId: 902,
  });
  assert.deepEqual(result.published.at(-1), { commandName: 'dev', status: 'running' });
});

test('a link-write failure converges the command without ever starting a process', async () => {
  const result = await launch({ updateRunPtyOutcome: () => launchFailure() });

  assert.ok(!result.calls.includes('start'), 'the backend must never be reached');
  assert.ok(result.calls.includes('abandon'), 'the allocation must be abandoned');
  assert.equal(result.runs.at(-1)?.status, 'failed');
  assert.equal(result.runs.at(-1)?.diagnosticReason, 'pty_launch_failed');
  assert.match(
    result.runs.at(-1)?.diagnosticDetail ?? '',
    /Could not record the process association; the command was not started/,
  );
  assert.equal(lastTransition(result)?.status, 'failed');
  assert.deepEqual(result.published.at(-1), { commandName: 'dev', status: 'failed' });
});

test('a link write reporting a vanished run is a defect, not a plausible failure', async () => {
  // The run was created moments ago under this command's lock. Reporting an
  // ordinary `failed` action would promise a diagnostic that has no row.
  const result = await launch({ updateRunPtyOutcome: () => 'missing' });

  assert.ok(Exit.isFailure(result.exit));
  assert.match(Cause.pretty(result.exit.cause), /vanished while linking PTY process 902/);
  assert.ok(!result.calls.includes('start'));
});

test('a step-8 finalize fault leaves run and state untouched as a unit', async () => {
  const result = await launch({
    ptyProcess: fakePtyProcessRow({ id: 902, status: 'exited', exitCode: 0 }),
    finalizeFault: (input) =>
      input.keying === 'run'
        ? new DatabaseError({ operation: 'finalize', cause: new Error('nope') })
        : null,
  });

  assert.equal(result.exit._tag, 'Failure');
  // No partial commit: the run is still open and the state still holds the
  // launch marker, so a later reconciliation can still land the true outcome.
  assert.equal(result.runs.at(-1)?.status, 'running');
  assert.deepEqual(lastTransition(result), {
    commandName: 'dev',
    status: 'running',
    activePtyProcessId: null,
    resolvedPorts: [],
  });
  assert.deepEqual(result.published, []);
});

test('an allocation failure converges the command and reports a readable diagnostic', async () => {
  const fixture = createFixture();
  writeConfig(fixture.rootPath, config);
  const runs: CommandRunRow[] = [];
  try {
    const action = await runCommandServiceEffect(
      fixture.rootPath,
      (service) => service.run({ worktreeId: 10, commandName: 'dev' }),
      {
        runs,
        pty: { allocateLaunch: () => Effect.fail(launchFailure()) },
      },
    );
    assert.equal(action.summary.status, 'failed');
    assert.equal(runs.at(-1)?.status, 'failed');
    assert.equal(runs.at(-1)?.diagnosticReason, 'pty_launch_failed');
  } finally {
    fixture.cleanup();
  }
});

test('a pruning failure completes only the run and preserves the prior entity status', async () => {
  const result = await launch({
    seedState: { ...commandState({ commandName: 'dev', status: 'suspended' }) },
    runs: [commandRun({ commandName: 'dev', status: 'running' })],
    pruneOutcome: () =>
      Effect.fail(new DatabaseError({ operation: 'prune', cause: new Error('nope') })),
  });

  assert.equal(result.exit._tag, 'Failure');
  assert.equal(result.runs.at(-1)?.status, 'failed');
  assert.equal(result.runs.at(-1)?.diagnosticReason, 'pty_launch_failed');
  assert.match(result.runs.at(-1)?.diagnosticDetail ?? '', /Could not prepare the launch/);
  // A resume's intent survives for the next activation, and the unchanged status
  // is republished so the client refetches the metadata carrying the diagnostic.
  assert.deepEqual(result.transitions, [], 'the prior entity status is never rewritten');
  assert.deepEqual(result.published, [{ commandName: 'dev', status: 'suspended' }]);
});

test('a marker-write failure converges identically, publishing the unchanged status', async () => {
  const result = await launch({
    transitionFault: (input) =>
      input.status === 'running' && input.activePtyProcessId === null
        ? new DatabaseError({ operation: 'transition', cause: new Error('nope') })
        : null,
  });

  assert.equal(result.exit._tag, 'Failure');
  assert.equal(result.runs.at(-1)?.status, 'failed');
  assert.match(result.runs.at(-1)?.diagnosticDetail ?? '', /Could not record the launch/);
  // No state row exists yet, so the catalog projection's `idle` is published.
  assert.deepEqual(result.published, [{ commandName: 'dev', status: 'idle' }]);
  assert.ok(
    !result.calls.includes('allocate'),
    'no allocation may be taken after the marker fails',
  );
});

test('cancellation before the run is linked completes only the run', async () => {
  const result = await launch({
    seedState: { ...commandState({ commandName: 'dev', status: 'suspended' }) },
    runs: [commandRun({ commandName: 'dev', status: 'running' })],
    // Hang inside run-history pruning: after the run exists, before the marker
    // and before any allocation.
    pruneOutcome: () => Effect.never,
    interruptWhen: (harness) => harness.runs.length > 1,
  });

  assert.equal(result.exit._tag, 'Failure');
  assert.equal(result.runs.at(-1)?.status, 'failed');
  assert.equal(result.runs.at(-1)?.diagnosticReason, 'pty_launch_failed');
  assert.match(result.runs.at(-1)?.diagnosticDetail ?? '', /cancelled before the command process/);
  // The resume intent survives an interrupted launch.
  assert.deepEqual(result.transitions, [], 'the prior entity status is never rewritten');
});

test('cancellation after the spawn installs the pointer and announces it', async () => {
  const result = await launch({
    start: Effect.never,
    interruptWhen: (harness) => harness.calls.includes('start'),
  });

  assert.equal(result.exit._tag, 'Failure');
  // The caller is gone, so this publish is the only announcement the client
  // will get for a command that is durably running.
  assert.deepEqual(lastTransition(result), {
    commandName: 'dev',
    status: 'running',
    activePtyProcessId: 902,
  });
  assert.deepEqual(result.published.at(-1), { commandName: 'dev', status: 'running' });
  assert.equal(result.runs.at(-1)?.ptyProcessId, 902);
});

test('cancellation whose PTY row is unreadable still installs the pointer', async () => {
  const result = await launch({
    start: Effect.never,
    interruptWhen: (harness) => harness.calls.includes('start'),
    // The linked row cannot be read during recovery. Nothing is known about the
    // process, so it must be treated as owned rather than as dead.
    ptyProcessReadFault: () => new DatabaseError({ operation: 'find', cause: new Error('nope') }),
  });

  assert.equal(result.exit._tag, 'Failure');
  assert.deepEqual(lastTransition(result), {
    commandName: 'dev',
    status: 'running',
    activePtyProcessId: 902,
  });
  assert.deepEqual(result.published.at(-1), { commandName: 'dev', status: 'running' });
  assert.equal(result.runs.at(-1)?.status, 'running', 'an unreadable row may not end the run');
});

test('an unreadable PTY row after the spawn keeps ownership rather than failing the launch', async () => {
  const result = await launch({
    ptyProcessReadFault: () => new DatabaseError({ operation: 'find', cause: new Error('nope') }),
  });

  assert.equal(result.exit._tag, 'Success');
  assert.deepEqual(lastTransition(result), {
    commandName: 'dev',
    status: 'running',
    activePtyProcessId: 902,
  });
  assert.equal(result.runs.at(-1)?.status, 'running');
});

// ---------------------------------------------------------------------------
// Endpoint resolution and snapshot supersession
// ---------------------------------------------------------------------------

/**
 * The launch stage that turns declared ports into the facts one incarnation
 * received. The invariant under test throughout is **single-writer
 * supersession**: the launch-in-progress marker is the only transition that may
 * name `resolvedPorts`, so everything before it preserves the previous
 * resolution and everything after it belongs to the new one.
 */

const portsConfig = `
commands:
  - name: dev
    command: pnpm dev
    ports:
      - port: 5173
        paths:
          - label: app
            path: /
      - envVar: API_PORT
        paths:
          - label: api
            path: /v1
      - envVar: DEBUG_PORT
`;

// A previously established resolution for the same command, used as the
// allocation preference a later launch may reuse.
const remembered: readonly ResolvedPortEntry[] = [
  { envVar: null, port: 5173, paths: [{ label: 'app', path: '/' }] },
  { envVar: 'API_PORT', port: 51824, paths: [{ label: 'api', path: '/v1' }] },
  { envVar: 'DEBUG_PORT', port: 9229, paths: [] },
];

test('the marker is the only transition that writes the resolved snapshot', async () => {
  const probe = commandPortProbe({ assign: [40_101, 40_102] });
  const result = await launch({ config: portsConfig, portProbe: probe.service });

  assert.deepEqual(result.transitions, [
    // Fixed entries pass through unprobed and in declaration order; allocated
    // entries carry the environment variable they were injected under, which is
    // also the identity the next launch matches its preference against.
    {
      commandName: 'dev',
      status: 'running',
      activePtyProcessId: null,
      resolvedPorts: [
        { envVar: null, port: 5173, paths: [{ label: 'app', path: '/' }] },
        { envVar: 'API_PORT', port: 40_101, paths: [{ label: 'api', path: '/v1' }] },
        { envVar: 'DEBUG_PORT', port: 40_102, paths: [] },
      ],
    },
    // The completed handoff omits the field entirely. This is the whole
    // supersession argument in one assertion: there is no second writer to keep
    // in step, so no recovery path can silently disagree with the marker.
    { commandName: 'dev', status: 'running', activePtyProcessId: 902 },
  ]);
  // The action output reports the resolution this launch established, not a
  // re-read of config and not a null placeholder.
  assert.deepEqual(
    Exit.isSuccess(result.exit) ? result.exit.value.summary.ports?.map((port) => port.port) : null,
    [5173, 40_101, 40_102],
  );
});

test('a fixed port is never offered to the probe', async () => {
  const probe = commandPortProbe({ assign: [40_101, 40_102] });
  await launch({ config: portsConfig, portProbe: probe.service });

  // Only the two allocated entries had a remembered value to check, and there
  // was none, so nothing was probed at all — least of all the user's 5173.
  assert.deepEqual(probe.calls.probed, []);
  assert.equal(probe.calls.assignments(), 2);
});

test('a launch reuses the remembered port when the probe finds it inactive', async () => {
  const probe = commandPortProbe({ inactive: [51_824, 9229] });
  const result = await launch({
    config: portsConfig,
    portProbe: probe.service,
    seedState: commandState({ commandName: 'dev', status: 'stopped', resolvedPorts: remembered }),
  });

  assert.deepEqual(probe.calls.probed, [51_824, 9229]);
  // Nothing was asked of the operating system: both preferences held.
  assert.equal(probe.calls.assignments(), 0);
  assert.deepEqual(
    markerSnapshot(result)?.map((entry) => entry.port),
    [5173, 51_824, 9229],
  );
});

test('a remembered port that is active falls through to a fresh assignment', async () => {
  // 51824 is taken by something else now; 9229 is still free.
  const probe = commandPortProbe({ inactive: [9229], assign: [40_555] });
  const result = await launch({
    config: portsConfig,
    portProbe: probe.service,
    seedState: commandState({ commandName: 'dev', status: 'stopped', resolvedPorts: remembered }),
  });

  assert.deepEqual(probe.calls.probed, [51_824, 9229]);
  assert.equal(probe.calls.assignments(), 1);
  // The unavailable preference moved; the available one did not. Stability is
  // per endpoint, not all-or-nothing.
  assert.deepEqual(
    markerSnapshot(result)?.map((entry) => entry.port),
    [5173, 40_555, 9229],
  );
});

test('allocated values reach the process and outrank an env file', async () => {
  const probe = commandPortProbe({ assign: [40_101, 40_102] });
  const result = await launch({
    config: `
commands:
  - name: dev
    command: pnpm dev
    envFiles:
      - .env
    ports:
      - envVar: API_PORT
`,
    files: { '.env': 'API_PORT=3000\nOTHER=kept\n' },
    portProbe: probe.service,
  });

  const env = result.envOverrides.at(-1);
  // The precedence ladder's top rung. A checked-in env file cannot win here:
  // the process must see the port value the runtime resolved and injected, or it
  // binds one thing while the UI advertises another.
  assert.equal(env?.API_PORT, '40101');
  // ...and only the colliding key is overridden.
  assert.equal(env?.OTHER, 'kept');
});

test('a command that declares no ports supersedes its old memory with an empty snapshot', async () => {
  const result = await launch({
    seedState: commandState({ commandName: 'dev', status: 'stopped', resolvedPorts: remembered }),
  });

  // The config no longer declares ports, so the previous resolution is not
  // merely unreported — it is forgotten. Preserving it would leave a stale
  // preference that a re-added endpoint would silently inherit.
  assert.deepEqual(markerSnapshot(result), []);
  assert.deepEqual(result.states.at(0)?.resolvedPorts, []);
  // The default probe dies on contact, so reaching here also proves a portless
  // launch performed no socket IO at all.
});

function markerSnapshot(result: Harness): readonly ResolvedPortEntry[] | undefined {
  return result.transitions.find((transition) => transition.resolvedPorts !== undefined)
    ?.resolvedPorts;
}

// ---------------------------------------------------------------------------
// Memory preservation across failure
// ---------------------------------------------------------------------------

/**
 * The other half of single-writer supersession, and the reason the snapshot
 * lives on the durable command state rather than the pruned run row: a launch
 * that never reached the marker must leave the last *successful* resolution
 * exactly as it found it. A user whose command failed to start should get their
 * familiar ports back on the next attempt, not a fresh set because the failure
 * erased the preference.
 */

function seededWithMemory() {
  return commandState({ commandName: 'dev', status: 'stopped', resolvedPorts: remembered });
}

// Each case is a distinct pre-marker exit; together they cover every branch that
// can end `runCommand` before the marker commits.
const preMarkerFailures = [
  {
    name: 'a missing working directory',
    options: {
      config: `
commands:
  - name: dev
    command: pnpm dev
    cwd: nowhere
    ports:
      - envVar: API_PORT
`,
    },
  },
  {
    name: 'an allocation failure',
    options: {
      config: portsConfig,
      portProbe: commandPortProbe({ assignFailure: 'System error EADDRINUSE' }).service,
    },
  },
  {
    name: 'an unreadable env file',
    options: {
      config: `
commands:
  - name: dev
    command: pnpm dev
    envFiles:
      - .missing
    ports:
      - port: 5173
`,
    },
  },
  {
    name: 'a prune fault',
    options: {
      config: portsConfig,
      portProbe: commandPortProbe({ assign: [40_101, 40_102] }).service,
      pruneOutcome: () => Effect.fail(launchFailure()),
    },
  },
  {
    name: 'a marker write fault',
    options: {
      config: portsConfig,
      portProbe: commandPortProbe({ assign: [40_101, 40_102] }).service,
      transitionFault: (input: { readonly activePtyProcessId: number | null }) =>
        input.activePtyProcessId === null ? launchFailure() : null,
    },
  },
] as const;

for (const scenario of preMarkerFailures) {
  test(`${scenario.name} leaves the previous resolution intact`, async () => {
    const result = await launch({ seedState: seededWithMemory(), ...scenario.options });

    // Nothing named the column, so nothing could have replaced it.
    assert.deepEqual(
      result.transitions.filter((transition) => transition.resolvedPorts !== undefined),
      [],
    );
    assert.deepEqual(result.states.at(0)?.resolvedPorts, remembered);
  });
}

test('a post-marker failure keeps the new incarnation snapshot, not the previous one', async () => {
  const probe = commandPortProbe({ assign: [40_101, 40_102] });
  const result = await launch({
    config: portsConfig,
    portProbe: probe.service,
    seedState: seededWithMemory(),
    updateRunPtyOutcome: () => launchFailure(),
  });

  // The marker committed, so this resolution is the command's history now even
  // though the process never started. Non-running projection hides it behind
  // `[]`, but it remains the preference the next launch prefers — which is what
  // makes a retry land on the same ports.
  assert.equal(result.runs.at(-1)?.status, 'failed');
  assert.deepEqual(
    result.states.at(0)?.resolvedPorts?.map((entry) => entry.port),
    [5173, 40_101, 40_102],
  );
});

test('an allocation failure follows the ordinary failed-run shape', async () => {
  const probe = commandPortProbe({ assignFailure: 'System error EADDRINUSE' });
  const result = await launch({
    config: portsConfig,
    portProbe: probe.service,
    seedState: seededWithMemory(),
  });

  // A completed failed run carrying the diagnostic — not the absence of a run.
  // The user needs somewhere to read why the launch did not happen, and this is
  // the same row every other pre-launch failure writes.
  const run = result.runs.at(-1);
  assert.equal(run?.status, 'failed');
  assert.equal(run?.diagnosticReason, 'port_allocation_failed');
  // The endpoint is named by the resolver and the cause by the adapter; both are
  // runtime-authored and safe to persist.
  assert.equal(
    run?.diagnosticDetail,
    'Could not allocate a port for API_PORT: System error EADDRINUSE',
  );
  assert.equal(lastTransition(result)?.status, 'failed');
  assert.deepEqual(result.published.at(-1), { commandName: 'dev', status: 'failed' });
  // Success-shaped output: the action did not error, it reported a failure. A
  // non-running command projects `[]` whatever the durable snapshot remembers.
  assert.ok(Exit.isSuccess(result.exit));
  assert.deepEqual(Exit.isSuccess(result.exit) ? result.exit.value.summary.ports : null, []);
  // The fixed entry was still excluded before the allocated one asked, so the
  // failure came from the operating system rather than from policy.
  assert.equal(probe.calls.assignments(), 1);
});

test('a launch interrupted during resolution leaves no run and no snapshot write', async () => {
  // `runCommand` claims that an interrupt during resolution is safe because
  // nothing durable exists yet. That claim had no assertion behind it, and it is
  // the one cancellation window the new stage introduced.
  const probe = commandPortProbe({ assign: [40_101, 40_102] });
  let enteredResolution = false;
  const result = await launch({
    config: portsConfig,
    portProbe: {
      ...probe.service,
      // Hold the fiber inside resolution until the test interrupts it. The flag
      // is what makes the interrupt land *inside* the stage: without it the
      // parent could interrupt before resolution began, and the test would stay
      // green even if the stage moved or disappeared.
      obtainEphemeralPort: Effect.sync(() => {
        enteredResolution = true;
      }).pipe(Effect.andThen(Effect.never)),
    },
    seedState: seededWithMemory(),
    interruptWhen: () => enteredResolution,
  });

  assert.ok(Exit.isInterrupted(result.exit));
  // No run was created, so no recovery was owed and none ran.
  assert.deepEqual(result.runs, []);
  assert.deepEqual(result.transitions, []);
  assert.deepEqual(result.published, []);
  // And the previous resolution is exactly as it was found.
  assert.deepEqual(result.states.at(0)?.resolvedPorts, remembered);
});
