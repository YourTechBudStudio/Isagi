import type { TerminalCacheSettings } from '@isagi/contracts';

import type { TerminalCacheSnapshot, TerminalEntrySnapshot } from './cache.js';

export function terminalRetentionCandidates(
  snapshot: TerminalCacheSnapshot,
  settings: TerminalCacheSettings,
  now: number,
): readonly TerminalEntrySnapshot[] {
  const hidden = snapshot.entries.filter(
    (entry) => !entry.visible && entry.lifecycle !== 'cold' && entry.hiddenSince !== null,
  );
  const ordered = [...hidden].sort(compareRetentionOrder);
  const ttlMilliseconds = settings.idleTtlMinutes * 60_000;
  const byteLimit = settings.maxEstimatedBufferMiB * 1024 * 1024;
  const retained = new Set(ordered);

  for (const entry of ordered) {
    if (ttlMilliseconds === 0 || now - (entry.hiddenSince ?? now) >= ttlMilliseconds) {
      retained.delete(entry);
    }
  }

  const newestFirst = [...retained].reverse();
  for (const entry of newestFirst.slice(settings.maxHiddenSessions)) {
    retained.delete(entry);
  }

  let retainedBytes = newestFirst
    .filter((entry) => retained.has(entry))
    .reduce((total, entry) => total + entry.estimatedBytes, 0);
  for (const entry of ordered) {
    if (retainedBytes <= byteLimit) {
      break;
    }
    if (retained.delete(entry)) {
      retainedBytes -= entry.estimatedBytes;
    }
  }

  return Object.freeze(ordered.filter((entry) => !retained.has(entry)));
}

function compareRetentionOrder(left: TerminalEntrySnapshot, right: TerminalEntrySnapshot): number {
  const recencyDifference = left.lastHiddenAt - right.lastHiddenAt;
  return recencyDifference === 0 ? left.key.localeCompare(right.key) : recencyDifference;
}
