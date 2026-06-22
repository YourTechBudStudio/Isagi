import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { derivePiConversation } from './conversation.js';

test('Pi conversation extracts user text and merges assistant text per turn', () => {
  assert.deepEqual(
    derivePiConversation([
      lifecycle('agent_start', 0),
      messageEnd(1, 'user', 'Build the thing'),
      messageEnd(2, 'assistant', [
        { type: 'thinking', thinking: 'private' },
        { type: 'text', text: 'First.' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} },
      ]),
      messageEnd(3, 'assistant', [{ type: 'text', text: 'Second.' }]),
      lifecycle('agent_end', 4),
    ]),
    [
      { role: 'user', parts: [{ type: 'text', text: 'Build the thing' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'First.' },
          { type: 'text', text: 'Second.' },
        ],
      },
    ],
  );
});

test('Pi conversation skips non-text assistant parts and empty text', () => {
  assert.deepEqual(
    derivePiConversation([
      lifecycle('agent_start', 0),
      messageEnd(1, 'assistant', [
        { type: 'thinking', thinking: 'private' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} },
        { type: 'text', text: '' },
      ]),
      lifecycle('agent_end', 2),
    ]),
    [],
  );
});

function lifecycle(
  nativeEvent: 'agent_start' | 'agent_end',
  seq: number,
): HarnessObservationRecord {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20,
    harness: 'pi',
    nativeEvent,
    event: {
      nativeEvent,
      context: { hasPendingMessages: null },
    },
  };
}

function messageEnd(
  seq: number,
  role: 'user' | 'assistant',
  content: unknown,
): HarnessObservationRecord {
  return {
    recordedAt: time(seq),
    seq,
    ptyProcessId: 20,
    harness: 'pi',
    nativeEvent: 'message_end',
    event: {
      nativeEvent: 'message_end',
      event: {
        message: { role, content },
      },
      context: { hasPendingMessages: null },
    },
  };
}

function time(seq: number) {
  return `2026-06-18T00:00:0${seq}.000Z`;
}
