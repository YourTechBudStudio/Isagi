import assert from 'node:assert/strict';
import test from 'node:test';

import { Cause, Effect, Exit, Option } from 'effect';

import type { WorktreeCommandPortConfig } from '../../project-config/project-config.schema.js';
import {
  CommandPortAllocationError,
  portEnvInjections,
  resolveCommandPorts,
  type ResolvedPortEntry,
} from '../commands.ports.js';
import { commandPortProbe } from './test-support.js';

/**
 * Allocation policy, with no sockets involved.
 *
 * The probe is the only IO the resolver has, so stubbing it leaves pure policy:
 * which port each declared entry ends up with, in what order, and which
 * questions were asked to get there.
 */

const fixed = (
  port: number,
  paths: ResolvedPortEntry['paths'] = [],
): WorktreeCommandPortConfig => ({
  kind: 'fixed',
  port,
  paths,
});

const allocated = (
  envVar: string,
  paths: ResolvedPortEntry['paths'] = [],
): WorktreeCommandPortConfig => ({ kind: 'allocated', envVar, paths });

const remembered = (envVar: string | null, port: number): ResolvedPortEntry => ({
  envVar,
  port,
  paths: [],
});

function succeeded<A>(exit: Exit.Exit<A, CommandPortAllocationError>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  assert.fail(`expected the resolution to succeed: ${Cause.pretty(exit.cause)}`);
}

// Unwraps the expected failure, and fails the test loudly on a defect or an
// unexpected success rather than letting `undefined` flow into an assertion.
function expectedFailure(exit: Exit.Exit<unknown, CommandPortAllocationError>) {
  assert.ok(Exit.isFailure(exit), 'expected the resolution to fail');
  const failure = Cause.failureOption(exit.cause);
  assert.ok(Option.isSome(failure), 'expected a tagged failure, not a defect or interruption');
  return failure.value;
}

function resolve(input: {
  readonly declared: readonly WorktreeCommandPortConfig[];
  readonly remembered?: readonly ResolvedPortEntry[] | null;
  readonly probe: ReturnType<typeof commandPortProbe>;
}) {
  return Effect.runPromiseExit(
    resolveCommandPorts({
      declared: input.declared,
      remembered: input.remembered ?? null,
      probe: input.probe.service,
    }),
  );
}

test('a fixed entry passes through unprobed', async () => {
  const probe = commandPortProbe();
  const exit = await resolve({ declared: [fixed(5173)], probe });

  assert.deepEqual(succeeded(exit), [{ envVar: null, port: 5173, paths: [] }]);
  // The user fixed this port. Probing it could only produce an opinion the
  // resolver is not allowed to act on, so it must not ask at all.
  assert.deepEqual(probe.calls.probed, []);
  assert.equal(probe.calls.assignments(), 0);
});

test('a command that declares nothing resolves to an empty snapshot', async () => {
  const probe = commandPortProbe();
  const exit = await resolve({ declared: [], probe });

  assert.deepEqual(succeeded(exit), []);
  assert.deepEqual(probe.calls.probed, []);
  assert.equal(probe.calls.assignments(), 0);
});

test('a remembered port is reused when the probe finds it inactive', async () => {
  const probe = commandPortProbe({ inactive: [51_824] });
  const exit = await resolve({
    declared: [allocated('API_PORT')],
    remembered: [remembered('API_PORT', 51_824)],
    probe,
  });

  assert.deepEqual(succeeded(exit), [{ envVar: 'API_PORT', port: 51_824, paths: [] }]);
  assert.deepEqual(probe.calls.probed, [51_824]);
  // Stability is the whole point: a reused port must not also consume a fresh
  // assignment.
  assert.equal(probe.calls.assignments(), 0);
});

test('an active remembered port falls through to a fresh assignment', async () => {
  const probe = commandPortProbe({ inactive: [], assign: [45_001] });
  const exit = await resolve({
    declared: [allocated('API_PORT')],
    remembered: [remembered('API_PORT', 51_824)],
    probe,
  });

  assert.deepEqual(succeeded(exit), [{ envVar: 'API_PORT', port: 45_001, paths: [] }]);
  assert.deepEqual(probe.calls.probed, [51_824]);
});

test('a probe fault means "do not reuse", not "fail the launch"', async () => {
  // The adapter folds its own operational faults to `false`. Policy must read
  // that as an unusable preference and carry on — a fresh assignment can still
  // serve the endpoint, so a probe fault ending the launch would be a
  // self-inflicted outage.
  const probe = commandPortProbe({
    inactive: [51_824],
    probeFault: (port) => port === 51_824,
    assign: [45_002],
  });
  const exit = await resolve({
    declared: [allocated('API_PORT')],
    remembered: [remembered('API_PORT', 51_824)],
    probe,
  });

  assert.deepEqual(succeeded(exit), [{ envVar: 'API_PORT', port: 45_002, paths: [] }]);
});

test('a remembered entry for a different variable is not a preference', async () => {
  const probe = commandPortProbe({ inactive: [51_824], assign: [45_003] });
  const exit = await resolve({
    declared: [allocated('WEB_PORT')],
    remembered: [remembered('API_PORT', 51_824)],
    probe,
  });

  assert.deepEqual(succeeded(exit), [{ envVar: 'WEB_PORT', port: 45_003, paths: [] }]);
  // Renaming the variable is a new allocation identity, so nothing is probed.
  assert.deepEqual(probe.calls.probed, []);
});

test('a remembered fixed entry can never be matched by an allocated declaration', async () => {
  // A fixed entry is remembered with `envVar: null`; nothing declared can carry
  // that as a variable name, so the snapshot's fixed rows are inert as
  // preferences.
  const probe = commandPortProbe({ inactive: [8080], assign: [45_004] });
  const exit = await resolve({
    declared: [allocated('API_PORT')],
    remembered: [remembered(null, 8080)],
    probe,
  });

  assert.deepEqual(succeeded(exit), [{ envVar: 'API_PORT', port: 45_004, paths: [] }]);
  assert.deepEqual(probe.calls.probed, []);
});

test('fixed exclusion holds regardless of declaration order', async () => {
  // The invariant the two-pass structure exists for. If exclusion were built as
  // the loop walked, the allocated entry here would reuse 5173 and then collide
  // with the fixed entry declared after it.
  const probe = commandPortProbe({ inactive: [5173], assign: [45_005] });
  const exit = await resolve({
    declared: [allocated('API_PORT'), fixed(5173)],
    remembered: [remembered('API_PORT', 5173)],
    probe,
  });

  assert.deepEqual(succeeded(exit), [
    { envVar: 'API_PORT', port: 45_005, paths: [] },
    { envVar: null, port: 5173, paths: [] },
  ]);
  // Excluded before the loop began, so the preference was never even probed.
  assert.deepEqual(probe.calls.probed, []);
});

test('an in-batch duplicate is discarded and re-asked', async () => {
  // Two allocated entries, and the OS hands the second one the port the first
  // just took. One command's endpoints must never resolve identically.
  const probe = commandPortProbe({ assign: [45_006, 45_006, 45_007] });
  const exit = await resolve({
    declared: [allocated('API_PORT'), allocated('WEB_PORT')],
    probe,
  });

  assert.deepEqual(succeeded(exit), [
    { envVar: 'API_PORT', port: 45_006, paths: [] },
    { envVar: 'WEB_PORT', port: 45_007, paths: [] },
  ]);
  assert.equal(probe.calls.assignments(), 3);
});

test('re-asking is bounded, and exhaustion is a policy failure naming the endpoint', async () => {
  const probe = commandPortProbe({ assign: [45_008, 45_008, 45_008, 45_008, 45_008, 45_008] });
  const exit = await resolve({
    declared: [allocated('API_PORT'), allocated('WEB_PORT')],
    probe,
  });

  const error = expectedFailure(exit);
  assert.ok(error instanceof CommandPortAllocationError);
  assert.equal(
    error.detail,
    'Could not allocate a port for WEB_PORT: the operating system kept returning ports already assigned to this command.',
  );
  // One successful assignment for API_PORT, then exactly five for WEB_PORT.
  assert.equal(probe.calls.assignments(), 6);
});

test('an adapter assignment failure is re-composed with the endpoint that asked', async () => {
  // The adapter knows the operational cause; only the resolver knows which
  // endpoint was being served. The persisted detail needs both.
  const probe = commandPortProbe({ assignFailure: 'System error EADDRNOTAVAIL' });
  const exit = await resolve({ declared: [allocated('API_PORT')], probe });

  const error = expectedFailure(exit);
  assert.ok(error instanceof CommandPortAllocationError);
  assert.equal(error.detail, 'Could not allocate a port for API_PORT: System error EADDRNOTAVAIL');
  // Terminal on the first refusal: a failing adapter is not something to
  // re-ask.
  assert.equal(probe.calls.assignments(), 1);
});

test('declaration order and paths survive resolution', async () => {
  const docs = [{ label: 'docs', path: '/docs' }];
  const health = [{ label: 'health', path: '/healthz' }];
  const probe = commandPortProbe({ assign: [45_009] });
  const exit = await resolve({
    declared: [fixed(8080, docs), allocated('API_PORT', health), fixed(9229)],
    probe,
  });

  assert.deepEqual(succeeded(exit), [
    { envVar: null, port: 8080, paths: docs },
    { envVar: 'API_PORT', port: 45_009, paths: health },
    { envVar: null, port: 9229, paths: [] },
  ]);
});

test('environment injections cover allocated entries only', () => {
  assert.deepEqual(
    portEnvInjections([
      { envVar: null, port: 8080, paths: [] },
      { envVar: 'API_PORT', port: 45_010, paths: [{ label: 'docs', path: '/docs' }] },
      { envVar: 'WEB_PORT', port: 5173, paths: [] },
    ]),
    { API_PORT: '45010', WEB_PORT: '5173' },
  );
  assert.deepEqual(portEnvInjections([]), {});
});
