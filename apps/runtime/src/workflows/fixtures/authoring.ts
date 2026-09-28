import type { WorkflowConversationMessage } from '@yourtechbudstudio/isagi-workflow-sdk';

/**
 * Authoring helpers the fixture workflows use inside their node functions. Nothing here may reach
 * for a test harness: all of it runs as ordinary author code.
 */

/** The last thing the agent said, as an author reads it. */
export function latestAssistantText(
  history: readonly WorkflowConversationMessage[],
  fallback = '(the agent said nothing)',
): string {
  for (const message of [...history].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = message.parts
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text.length > 0) return text;
  }
  return fallback;
}
