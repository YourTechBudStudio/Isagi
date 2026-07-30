import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { updateCopy } from './updates.js';

describe('updateCopy', () => {
  it('agrees with itself about how many agents are working', () => {
    assert.equal(updateCopy.confirm.workingTitle(1), '1 agent is working right now.');
    assert.match(updateCopy.confirm.workingBody(1, '0.4.3'), /that agent stops where it is/);

    assert.equal(updateCopy.confirm.workingTitle(3), '3 agents are working right now.');
    assert.match(updateCopy.confirm.workingBody(3, '0.4.3'), /those agents stop where they are/);
  });

  it('names the consequence without overclaiming it', () => {
    const sentences = [
      updateCopy.confirm.workingBody(2, '0.4.3'),
      updateCopy.confirm.unknownBody('0.4.3'),
    ];

    for (const sentence of sentences) {
      // What we know: Isagi closes and work stops. What we must not imply:
      // that anything is lost, or that it picks back up on its own.
      assert.match(sentence, /closes Isagi/);
      assert.doesNotMatch(sentence, /lost|delete|resume|pick up where/i);
    }
  });

  it('distinguishes unknown activity from nothing working', () => {
    assert.match(updateCopy.confirm.unknownTitle, /couldn't check/i);
    assert.doesNotMatch(updateCopy.confirm.unknownTitle, /\b0\b|no agents/i);
  });

  it('keeps humour and marketing out of the update surface', () => {
    const banned =
      /empower|unlock|supercharge|seamless|delightful|✨|🎉|awesome|magic|sit tight|hang tight/i;

    for (const value of collectStrings(updateCopy)) {
      assert.doesNotMatch(value, banned, `banned phrasing in: ${value}`);
    }
  });
});

/**
 * Copy functions take a count, a version, or a version and a percentage, in
 * varying orders. Every shape is tried against every function and the ones that
 * do not fit are discarded — including the empty version, so the versionless
 * fallbacks are scanned for banned phrasing too.
 */
const argumentShapes: readonly unknown[][] = [
  [1],
  [2],
  ['0.4.3'],
  [''],
  [1, '0.4.3'],
  [2, '0.4.3'],
  [1, ''],
  ['0.4.3', 38],
  ['', 38],
];

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') {
    const sample = value as (...args: unknown[]) => unknown;
    return argumentShapes
      .map((shape) => {
        try {
          return sample(...shape);
        } catch {
          // A shape this function does not accept, not a defect in the copy.
          return undefined;
        }
      })
      .filter((result): result is string => typeof result === 'string');
  }
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}
