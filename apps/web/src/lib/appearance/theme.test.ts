import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readThemeHint } from './theme.js';

describe('readThemeHint', () => {
  it('returns a remembered theme', () => {
    assert.equal(
      readThemeHint(() => 'light'),
      'light',
    );
    assert.equal(
      readThemeHint(() => 'dark'),
      'dark',
    );
  });

  it('ignores a missing, unknown, or unreadable hint', () => {
    assert.equal(
      readThemeHint(() => null),
      null,
    );
    assert.equal(
      readThemeHint(() => 'system'),
      null,
    );
    assert.equal(
      readThemeHint(() => {
        throw new Error('storage disabled');
      }),
      null,
    );
  });
});
