import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveRuntimeLocality, type RuntimeLocality } from './locality.js';

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
    name: 'hosted is local — the desktop spawned its runtime here',
    input: { hosted: true, browserLocalAssertion: undefined },
    expected: 'local',
  },
  {
    name: 'hosted ignores a browser assertion',
    input: { hosted: true, browserLocalAssertion: 'no' },
    expected: 'local',
  },
  {
    name: 'unhosted with the exact literal true is local',
    input: { hosted: false, browserLocalAssertion: 'true' },
    expected: 'local',
  },
  {
    name: 'unhosted with no assertion is non-local',
    input: { hosted: false, browserLocalAssertion: undefined },
    expected: 'non_local',
  },
  {
    name: 'unhosted with an empty assertion is non-local',
    input: { hosted: false, browserLocalAssertion: '' },
    expected: 'non_local',
  },
  {
    name: 'unhosted with a differently-cased assertion is non-local',
    input: { hosted: false, browserLocalAssertion: 'TRUE' },
    expected: 'non_local',
  },
  {
    name: 'unhosted with a truthy-looking assertion is non-local',
    input: { hosted: false, browserLocalAssertion: '1' },
    expected: 'non_local',
  },
  {
    name: 'unhosted with a malformed assertion is non-local',
    input: { hosted: false, browserLocalAssertion: 'yes please' },
    expected: 'non_local',
  },
];

for (const testCase of cases) {
  test(`runtime locality: ${testCase.name}`, () => {
    assert.equal(deriveRuntimeLocality(testCase.input), testCase.expected);
  });
}
