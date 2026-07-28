import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateTerminalFit } from './terminal-geometry.js';

test('terminal fit uses host size minus terminal padding', () => {
  assert.deepEqual(
    calculateTerminalFit({
      hostWidth: 803,
      hostHeight: 418,
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 8,
      paddingBottom: 8,
      cellWidth: 7.5,
      cellHeight: 16,
    }),
    { cols: 103, rows: 25 },
  );
});

test('terminal fit does not report geometry before host or cell dimensions are usable', () => {
  const readyMeasurement = {
    hostWidth: 803,
    hostHeight: 418,
    paddingLeft: 0,
    paddingRight: 0,
    paddingTop: 0,
    paddingBottom: 0,
    cellWidth: 7.5,
    cellHeight: 16,
  };

  assert.equal(calculateTerminalFit({ ...readyMeasurement, hostWidth: 0 }), null);
  assert.equal(calculateTerminalFit({ ...readyMeasurement, hostHeight: 0 }), null);
  assert.equal(calculateTerminalFit({ ...readyMeasurement, cellWidth: 0 }), null);
  assert.equal(calculateTerminalFit({ ...readyMeasurement, cellHeight: Number.NaN }), null);
});

test('terminal fit preserves xterm minimum geometry for tiny visible hosts', () => {
  assert.deepEqual(
    calculateTerminalFit({
      hostWidth: 1,
      hostHeight: 1,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
      cellWidth: 10,
      cellHeight: 20,
    }),
    { cols: 2, rows: 1 },
  );
});
