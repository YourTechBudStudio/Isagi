import {
  workflowCheckpointWarningReasonSchema,
  type WorkflowCheckpointWarningGroup,
} from '@isagi/contracts';

import type { CheckpointEntry } from './resolve.js';

/** How many sample paths one warning group carries. */
export const warningGroupSampleLimit = 5;

/**
 * The bounded summary of what one checkpoint itself observed, computed once from the entries it
 * commits so a detail read never walks its warning rows.
 *
 * Only warnings this checkpoint observed count: inherited region warnings belong to the layer that
 * produced them. One group per reason, in vocabulary order; samples are the first paths in entry
 * order. The truncation sentinel is not a group: its `omitted` count joins `uncaptured_dirty_path`,
 * the one reason ever capped, so that group's count is the true total while its samples stay the
 * first paths actually stored.
 */
export function warningGroupsOf(
  entries: readonly CheckpointEntry[],
  checkpointKey: string,
): readonly WorkflowCheckpointWarningGroup[] {
  const counts = new Map<string, number>();
  const samples = new Map<string, string[]>();
  let omitted = 0;
  for (const entry of entries) {
    if (entry.kind !== 'warning' || entry.observedBy !== checkpointKey) continue;
    if (entry.reason === 'warnings_truncated') {
      const value = entry.detail?.omitted;
      omitted += typeof value === 'number' ? value : 0;
      continue;
    }
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
    const paths = samples.get(entry.reason) ?? [];
    if (entry.path !== null && paths.length < warningGroupSampleLimit) paths.push(entry.path);
    samples.set(entry.reason, paths);
  }
  const groups: WorkflowCheckpointWarningGroup[] = [];
  for (const reason of workflowCheckpointWarningReasonSchema.literals) {
    if (reason === 'warnings_truncated') continue;
    const count = (counts.get(reason) ?? 0) + (reason === 'uncaptured_dirty_path' ? omitted : 0);
    if (count === 0) continue;
    groups.push({ reason, count, samples: samples.get(reason) ?? [] });
  }
  return groups;
}
