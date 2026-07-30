import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { didPendingActionSettleSuccessfully } from './context-menu-state.js';

describe('ContextMenu pending settlement', () => {
  it('closes when a pending action settles successfully', () => {
    assert.equal(
      didPendingActionSettleSuccessfully({
        previouslyPending: true,
        pending: false,
        error: null,
      }),
      true,
    );
  });

  it('stays open when a pending action settles with an error', () => {
    assert.equal(
      didPendingActionSettleSuccessfully({
        previouslyPending: true,
        pending: false,
        error: 'Surface deletion failed.',
      }),
      false,
    );
  });

  it('does not close for an idle or still-pending item', () => {
    assert.equal(
      didPendingActionSettleSuccessfully({
        previouslyPending: false,
        pending: false,
        error: null,
      }),
      false,
    );
    assert.equal(
      didPendingActionSettleSuccessfully({
        previouslyPending: true,
        pending: true,
        error: null,
      }),
      false,
    );
  });
});
