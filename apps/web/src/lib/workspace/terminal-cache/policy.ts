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
  const evicted = new Set<TerminalEntrySnapshot>();

  for (const entry of ordered) {
    if (ttlMilliseconds === 0 || now - (entry.hiddenSince ?? now) >= ttlMilliseconds) {
      evicted.add(entry);
    }
  }

  const retainedNewestFirst = ordered.filter((entry) => !evicted.has(entry)).reverse();
  for (const entry of retainedNewestFirst.slice(settings.maxHiddenSessions)) {
    evicted.add(entry);
  }

  let retainedBytes =
    snapshot.totalEstimatedBytes -
    [...evicted].reduce((total, entry) => total + entry.estimatedBytes, 0);
  for (const entry of ordered) {
    if (retainedBytes <= byteLimit) {
      break;
    }
    if (!evicted.has(entry)) {
      evicted.add(entry);
      retainedBytes -= entry.estimatedBytes;
    }
  }

  return Object.freeze(ordered.filter((entry) => evicted.has(entry)));
}

function compareRetentionOrder(left: TerminalEntrySnapshot, right: TerminalEntrySnapshot): number {
  const recencyDifference = left.lastHiddenAt - right.lastHiddenAt;
  return recencyDifference === 0 ? left.key.localeCompare(right.key) : recencyDifference;
}
