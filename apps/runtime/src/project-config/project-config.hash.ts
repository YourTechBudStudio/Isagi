import { createHash } from 'node:crypto';

import type { WorktreeHooksConfig } from './project-config.schema.js';

export function hashWorktreeHooks(config: WorktreeHooksConfig) {
  return createHash('sha256')
    .update(stableStringify({ schema: 'isagi.worktreeHooks.v1', hooks: config }))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}
