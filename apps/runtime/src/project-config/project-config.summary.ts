import type { WorktreeSetupSummary } from '@isagi/contracts';

import type { WorktreeHooksConfig } from './project-config.schema.js';

export function summarizeWorktreeHooks(
  config: WorktreeHooksConfig,
): readonly WorktreeSetupSummary[] {
  return config.postCreate.map((hook, index) => {
    const oneBased = index + 1;
    switch (hook.type) {
      case 'copy':
        return {
          index: oneBased,
          type: hook.type,
          label: `copy ${hook.src} → ${hook.dest}`,
          detail: `include ${hook.include.join(', ')}${hook.exclude.length ? ` · exclude ${hook.exclude.join(', ')}` : ''}`,
        } satisfies WorktreeSetupSummary;
      case 'symlink':
        return {
          index: oneBased,
          type: hook.type,
          label: `symlink ${hook.src} → ${hook.dest}`,
        } satisfies WorktreeSetupSummary;
      case 'command':
        return {
          index: oneBased,
          type: hook.type,
          label: `run ${hook.run}`,
          detail: `cwd ${hook.cwd} · timeout ${hook.timeout} · inherits runtime environment`,
          envKeys: Object.keys(hook.env).sort(),
        } satisfies WorktreeSetupSummary;
    }
  });
}
