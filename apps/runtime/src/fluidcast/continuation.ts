// Copied verbatim from Fluidcast's reference backend (`apps/backend/src/conversation/modes.ts`),
// which Isagi must not import: the story requires these strings reproduced, and
// `tests/continuation.test.ts` pins them. The reference's brainstorming hook is deliberately not
// copied: Isagi adds no modifier of its own, while a skill the listener types as `/name` passes
// through to the worker.
import type { SessionConfig } from '@yourtechbudstudio/fluidcast-harness';
import {
  forwardToolName,
  type ForwardResult,
} from '@yourtechbudstudio/fluidcast-tool-agent/schema';

/** The preloaded first message, sent when the listener taps Tap to start. */
export const continueMessage = 'Walk me through your last answer.';
/** The label of the preloaded answered call: the native session's last answer. */
export const continueCallLabel = 'Your last answer in this session';

/**
 * The preloaded start: the message, then the native session's last answer as an answered
 * `forward_agent` call, so the voice reads it as its own work exactly as it reads any forward
 * result, and the preset's own reminders apply. Read as a labelled context instead, the voice put
 * the answer's questions on a screen and moved on (measured in October 2026).
 */
export const continueStart = (answer: string): NonNullable<SessionConfig['start']> => ({
  message: continueMessage,
  call: {
    label: continueCallLabel,
    tool: forwardToolName,
    input: {},
    result: { messages: [answer] } satisfies ForwardResult,
  },
});
