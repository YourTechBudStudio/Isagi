import assert from 'node:assert/strict';
import test from 'node:test';

import {
  brand,
  isWorkflowBranded,
  readWorkflowContractVersion,
  workflowContractVersion,
} from './brand.js';

test('the contract version is 3', () => {
  assert.equal(workflowContractVersion, 3);
});

test('recognition reads plain data, so a separately bundled copy is still recognized', () => {
  // What a second, independently evaluated copy of this module would produce. No constructor,
  // prototype, or symbol is shared with the registrations this process creates.
  const foreign = JSON.parse(JSON.stringify({ ...brand('graph'), key: 'Root' })) as unknown;
  assert.ok(isWorkflowBranded(foreign, 'graph'));
});

test('recognition rejects the wrong kind, a bare object, and the primitives', () => {
  assert.equal(isWorkflowBranded(brand('graph'), 'edge'), false);
  assert.equal(isWorkflowBranded({ key: 'Root' }, 'graph'), false);
  assert.equal(isWorkflowBranded(null, 'graph'), false);
  assert.equal(isWorkflowBranded(undefined, 'graph'), false);
  assert.equal(isWorkflowBranded('graph', 'graph'), false);
  assert.equal(isWorkflowBranded(7, 'graph'), false);
});

test('a stale bundle is not branded, but its contract version stays readable for diagnostics', () => {
  const stale = { isagiContract: 2, isagiKind: 'workflow' };
  assert.equal(isWorkflowBranded(stale, 'workflow'), false);
  assert.equal(readWorkflowContractVersion(stale), 2);
  assert.equal(readWorkflowContractVersion({}), null);
  assert.equal(readWorkflowContractVersion(null), null);
});
