import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { deriveCodexConversation } from './conversation.js';

test('Codex conversation extracts prompt and final assistant text from hook input', () => {
  assert.deepEqual(
    deriveCodexConversation([
      record('UserPromptSubmit', 0, { prompt: 'inspect the repo', turn_id: 'turn-1' }),
      record('Stop', 1, {
        last_assistant_message: 'done',
        turn_id: 'turn-1',
      }),
    ]),
    [
      { role: 'user', parts: [{ type: 'text', text: 'inspect the repo' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'done' }] },
    ],
  );
});

test('Codex conversation omits empty prompts and null assistant messages', () => {
  assert.deepEqual(
    deriveCodexConversation([
      record('UserPromptSubmit', 0, { prompt: '' }),
      record('Stop', 1, { last_assistant_message: null }),
    ]),
    [],
  );
});

test('Codex conversation ignores repeated Stop records before another prompt', () => {
  assert.deepEqual(
    deriveCodexConversation([
      record('UserPromptSubmit', 0, { prompt: 'one', turn_id: 'turn-1' }),
      record('Stop', 1, { last_assistant_message: 'first stop', turn_id: 'turn-1' }),
      record('Stop', 2, { last_assistant_message: 'second stop', turn_id: 'turn-1' }),
    ]),
    [
      { role: 'user', parts: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'first stop' }] },
    ],
  );
});

function record(
  nativeEvent: string,
  seq: number,
  input: Record<string, unknown>,
): HarnessObservationRecord {
  return {
    recordedAt: `2026-06-18T00:00:0${seq}.000Z`,
    seq,
    ptyProcessId: 20,
    harness: 'codex',
    nativeEvent,
    event: {
      nativeEvent,
      notificationType: null,
      input: { hook_event_name: nativeEvent, ...input },
    },
  };
}
