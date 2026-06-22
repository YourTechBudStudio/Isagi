import type { HarnessObservationRecord } from '../projection.js';
import type { ConversationMessage } from '../types.js';

export function deriveCodexConversation(
  _records: readonly HarnessObservationRecord[],
): readonly ConversationMessage[] {
  return [];
}
