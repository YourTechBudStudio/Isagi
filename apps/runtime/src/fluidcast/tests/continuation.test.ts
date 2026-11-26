import assert from 'node:assert/strict';
import test from 'node:test';

import { continueCallLabel, continueMessage, continueStart } from '../continuation.js';

test('the continuation strings equal the reference backend verbatim', () => {
  // Pinned copies of Fluidcast's `apps/backend/src/conversation/modes.ts`: the story requires them reproduced.
  assert.equal(continueMessage, 'Walk me through your last answer.');
  assert.equal(continueCallLabel, 'Your last answer in this session');
});

test('the continuation start replays the last answer as an answered forward_agent call', () => {
  assert.deepEqual(continueStart('The answer.'), {
    message: continueMessage,
    call: {
      label: continueCallLabel,
      tool: 'forward_agent',
      input: {},
      result: { messages: ['The answer.'] },
    },
  });
});
