// Copied verbatim from Fluidcast's reference backend (`apps/backend/src/conversation/modes.ts`),
// which Isagi must not import: the story requires these strings reproduced, and
// `tests/continuation.test.ts` pins them. The reference's brainstorming hook is deliberately not
// copied: Isagi adds no skill modifier.
import type { Reminders } from '@yourtechbudstudio/fluidcast-core/generation';
import type { TranscriptEntry } from '@yourtechbudstudio/fluidcast-tool-agent';

/** The preloaded first message, sent when the listener taps Tap to start. */
export const continueMessage = 'Walk me through your last answer.';
/** The label of the preloaded context: the native session's last answer. */
export const continueContextLabel = 'Your last answer in this session';
/**
 * The reminder for the preloaded message: one framing sentence, then the Guided Walkthrough's
 * `reply` reminder verbatim.
 */
export const continueReminder =
  'The <context> above is your own last answer in this session; treat it as a `forward_agent` result. Present only the first segment of this result now, then stop with an `ask`.';

/** The reminder above for a message read with context (only the preloaded start has any), the preset's otherwise. */
export const continueReminders =
  (preset: Reminders): Reminders =>
  (event) =>
    event._tag === 'UserMessage' && event.context.length > 0 ? continueReminder : preset(event);

/**
 * The agent's last answer: every top-level `text` entry after the last top-level `prompt`, joined
 * with a blank line as a forward result reads, or `undefined` when there is none.
 */
export const lastAnswer = (entries: ReadonlyArray<TranscriptEntry>): string | undefined => {
  const topLevel = entries.filter((entry) => entry.parentToolUseId === null);
  const start = topLevel.findLastIndex((entry) => entry._tag === 'prompt');
  const answer = topLevel
    .slice(start + 1)
    .flatMap((entry) => (entry._tag === 'text' ? [entry.text] : []))
    .join('\n\n');
  return answer === '' ? undefined : answer;
};
