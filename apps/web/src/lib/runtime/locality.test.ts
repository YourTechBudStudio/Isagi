import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostRuntimeStatusSnapshot } from '../desktop-bridge.js';
import { deriveRuntimeLocality, type RuntimeLocality } from './locality.js';

function snapshot(
  ownership: 'managed' | 'external',
  state: 'connecting' | 'ready',
): HostRuntimeStatusSnapshot {
  return { protocolVersion: 1, revision: 1, ownership, state };
}

/**
 * The whole input space, as data. Only two categories yield `local`, and both are
 * positive assertions of co-location: the desktop launched this runtime itself,
 * or an operator built the browser bundle claiming the runtime is on their
 * machine. Every other row withholds the URL affordance.
 */
const cases: readonly {
  readonly name: string;
  readonly input: Parameters<typeof deriveRuntimeLocality>[0];
  readonly expected: RuntimeLocality;
}[] = [
  {
    name: 'hosted managed runtime is local — the desktop spawned it here',
    input: {
      hosted: true,
      snapshot: snapshot('managed', 'ready'),
      browserLocalAssertion: undefined,
    },
    expected: 'local',
  },
  {
    name: 'hosted managed is local while still connecting — ownership, not readiness, decides',
    input: {
      hosted: true,
      snapshot: snapshot('managed', 'connecting'),
      browserLocalAssertion: undefined,
    },
    expected: 'local',
  },
  {
    name: 'hosted external is non-local — attachment establishes no co-location',
    input: {
      hosted: true,
      snapshot: snapshot('external', 'ready'),
      browserLocalAssertion: undefined,
    },
    expected: 'non_local',
  },
  {
    name: 'hosted external unreachable is non-local',
    input: {
      hosted: true,
      snapshot: {
        protocolVersion: 1,
        revision: 2,
        ownership: 'external',
        state: 'unreachable',
        reason: 'external_health_check_failed',
      },
      browserLocalAssertion: undefined,
    },
    expected: 'non_local',
  },
  {
    name: 'hosted with no snapshot yet is non-local',
    input: { hosted: true, snapshot: null, browserLocalAssertion: undefined },
    expected: 'non_local',
  },
  {
    name: 'a host bridge outranks a browser assertion that contradicts it',
    input: { hosted: true, snapshot: snapshot('external', 'ready'), browserLocalAssertion: 'true' },
    expected: 'non_local',
  },
  {
    name: 'unhosted with the exact literal true is local',
    input: { hosted: false, snapshot: null, browserLocalAssertion: 'true' },
    expected: 'local',
  },
  {
    name: 'unhosted with no assertion is non-local',
    input: { hosted: false, snapshot: null, browserLocalAssertion: undefined },
    expected: 'non_local',
  },
  {
    name: 'unhosted with an empty assertion is non-local',
    input: { hosted: false, snapshot: null, browserLocalAssertion: '' },
    expected: 'non_local',
  },
  {
    name: 'unhosted with a differently-cased assertion is non-local',
    input: { hosted: false, snapshot: null, browserLocalAssertion: 'TRUE' },
    expected: 'non_local',
  },
  {
    name: 'unhosted with a truthy-looking assertion is non-local',
    input: { hosted: false, snapshot: null, browserLocalAssertion: '1' },
    expected: 'non_local',
  },
  {
    name: 'unhosted with a malformed assertion is non-local',
    input: { hosted: false, snapshot: null, browserLocalAssertion: 'yes please' },
    expected: 'non_local',
  },
];

for (const testCase of cases) {
  test(`runtime locality: ${testCase.name}`, () => {
    assert.equal(deriveRuntimeLocality(testCase.input), testCase.expected);
  });
}

test('only ownership-managed and the exact browser assertion yield local', () => {
  const local = cases.filter((testCase) => testCase.expected === 'local');
  assert.equal(local.length, 3);
  for (const testCase of local) {
    assert.ok(
      testCase.input.hosted
        ? testCase.input.snapshot?.ownership === 'managed'
        : testCase.input.browserLocalAssertion === 'true',
    );
  }
});
