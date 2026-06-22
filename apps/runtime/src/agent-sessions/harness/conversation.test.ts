import assert from 'node:assert/strict';
import test from 'node:test';

import { Effect } from 'effect';

import { getConversationHistory } from './conversation.js';

test('conversation history dispatcher is inert in phase 1', async () => {
  const history = await Effect.runPromise(getConversationHistory(10));

  assert.deepEqual(history, []);
});
