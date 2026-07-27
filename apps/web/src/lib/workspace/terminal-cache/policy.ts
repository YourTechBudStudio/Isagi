import type { TerminalCacheSnapshot, TerminalEntrySnapshot } from './cache.js';

export interface TerminalCachePolicy {
  readonly scrollbackLines: number;
  readonly idleTtlMinutes: number;
  readonly maxHiddenSessions: number;
  readonly maxEstimatedBufferMiB: number;
}

export const defaultTerminalCachePolicy: TerminalCachePolicy = Object.freeze({
  scrollbackLines: 5_000,
  idleTtlMinutes: 180,
  maxHiddenSessions: 4,
  maxEstimatedBufferMiB: 64,
});

const policyBounds = {
  scrollbackLines: 100_000,
  idleTtlMinutes: 10_080,
  maxHiddenSessions: 32,
  maxEstimatedBufferMiB: 2_048,
} as const;

export function normalizeTerminalCachePolicy(policy: TerminalCachePolicy): TerminalCachePolicy {
  return Object.freeze({
    scrollbackLines: normalizeInteger(policy.scrollbackLines, policyBounds.scrollbackLines),
    idleTtlMinutes: normalizeInteger(policy.idleTtlMinutes, policyBounds.idleTtlMinutes),
    maxHiddenSessions: normalizeInteger(policy.maxHiddenSessions, policyBounds.maxHiddenSessions),
    maxEstimatedBufferMiB: normalizeInteger(
      policy.maxEstimatedBufferMiB,
      policyBounds.maxEstimatedBufferMiB,
    ),
  });
}

export function terminalRetentionCandidates(
  snapshot: TerminalCacheSnapshot,
  policy: TerminalCachePolicy,
  now: number,
): readonly TerminalEntrySnapshot[] {
  const hidden = snapshot.entries.filter(
    (entry) => !entry.visible && entry.lifecycle !== 'cold' && entry.hiddenSince !== null,
  );
  const ordered = [...hidden].sort(compareRetentionOrder);
  const ttlMilliseconds = policy.idleTtlMinutes * 60_000;
  const byteLimit = policy.maxEstimatedBufferMiB * 1024 * 1024;
  const retained = new Set(ordered);

  for (const entry of ordered) {
    if (ttlMilliseconds === 0 || now - (entry.hiddenSince ?? now) >= ttlMilliseconds) {
      retained.delete(entry);
    }
  }

  const newestFirst = [...retained].reverse();
  for (const entry of newestFirst.slice(policy.maxHiddenSessions)) {
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

function normalizeInteger(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`Terminal cache policy value must be an integer from 0 to ${maximum}.`);
  }
  return value;
}
