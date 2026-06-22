import assert from 'node:assert/strict';
import test from 'node:test';

import type { HarnessObservationRecord } from '../projection.js';
import { deriveOpenCodeConversation } from './conversation.js';

test('OpenCode conversation extracts user text and completed assistant text', () => {
  assert.deepEqual(
    deriveOpenCodeConversation([
      chatMessage(0, 'make it work'),
      completedTextPart(1, { id: 'part-1', messageId: 'assistant-1', text: 'first ' }),
      completedTextPart(2, { id: 'part-2', messageId: 'assistant-1', text: 'answer' }),
      completedAssistantMessage(3, 'assistant-1'),
      record('session.idle', 4),
    ]),
    [
      { role: 'user', parts: [{ type: 'text', text: 'make it work' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'first ' },
          { type: 'text', text: 'answer' },
        ],
      },
    ],
  );
});

test('OpenCode conversation merges multiple completed assistant messages per turn', () => {
  assert.deepEqual(
    deriveOpenCodeConversation([
      chatMessage(0, 'one'),
      completedTextPart(1, { id: 'part-1', messageId: 'assistant-1', text: 'alpha' }),
      completedAssistantMessage(2, 'assistant-1'),
      completedTextPart(3, { id: 'part-2', messageId: 'assistant-2', text: 'beta' }),
      completedAssistantMessage(4, 'assistant-2'),
      record('session.idle', 5),
    ]),
    [
      { role: 'user', parts: [{ type: 'text', text: 'one' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'alpha' },
          { type: 'text', text: 'beta' },
        ],
      },
    ],
  );
});

test('OpenCode conversation ignores incomplete assistant message updates and non-text user parts', () => {
  assert.deepEqual(
    deriveOpenCodeConversation([
      {
        ...chatMessage(0, ''),
        event: {
          nativeEvent: 'chat.message',
          input: { sessionID: 'opencode-session-1' },
          output: {
            parts: [
              { type: 'tool', state: { status: 'completed' } },
              { type: 'text', text: 'kept user text' },
            ],
          },
        },
      },
      completedTextPart(1, { id: 'part-1', messageId: 'assistant-1', text: 'hidden' }),
      record('message.updated', 2),
      record('session.idle', 3),
    ]),
    [{ role: 'user', parts: [{ type: 'text', text: 'kept user text' }] }],
  );
});

function chatMessage(seq: number, text: string): HarnessObservationRecord {
  return {
    ...record('chat.message', seq),
    event: {
      nativeEvent: 'chat.message',
      input: { sessionID: 'opencode-session-1' },
      output: {
        message: { role: 'user', id: 'user-1' },
        parts: text ? [{ type: 'text', text }] : [],
      },
    },
  };
}

function completedTextPart(
  seq: number,
  input: { readonly id: string; readonly messageId: string; readonly text: string },
): HarnessObservationRecord {
  return {
    ...record('message.part.updated', seq),
    event: {
      nativeEvent: 'message.part.updated',
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: input.id,
            sessionID: 'opencode-session-1',
            messageID: input.messageId,
            type: 'text',
            text: input.text,
            time: { start: seq, end: seq + 1 },
          },
        },
      },
    },
  };
}

function completedAssistantMessage(seq: number, messageId: string): HarnessObservationRecord {
  return {
    ...record('message.updated', seq),
    event: {
      nativeEvent: 'message.updated',
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: messageId,
            sessionID: 'opencode-session-1',
            role: 'assistant',
            time: { created: seq, completed: seq + 1 },
          },
        },
      },
    },
  };
}

function record(nativeEvent: string, seq: number): HarnessObservationRecord {
  return {
    recordedAt: `2026-06-18T00:00:0${seq}.000Z`,
    seq,
    ptyProcessId: 20,
    harness: 'opencode',
    nativeEvent,
    event: {
      nativeEvent,
      event: {
        type: nativeEvent,
        properties: { sessionID: 'opencode-session-1' },
      },
    },
  };
}
