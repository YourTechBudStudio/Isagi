import { commandHookSource } from '../ledger.common.js';

export function codexHookSource() {
  // Codex can emit SessionStart for ephemeral `/side` forks. The observer owns
  // promotion of a confirmed durable thread into resumable metadata; the hook
  // only records the native event stream.
  return commandHookSource('codex', { persistHarnessSessionId: false });
}
