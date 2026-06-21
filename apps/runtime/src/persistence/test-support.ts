import { join } from 'node:path';

import type { DataDirectoryService, IsagiDataDirectory } from './data-directory.service.js';

/**
 * Builds a {@link DataDirectoryService} stub rooted at `root`, deriving the
 * standard child paths the same way the live service does. Pass `overrides` to
 * point an individual path elsewhere (e.g. a custom worktrees parent).
 */
export function makeTestDataDirectory(
  root: string,
  overrides: Partial<IsagiDataDirectory> = {},
): DataDirectoryService {
  return {
    paths: {
      root,
      databasePath: join(root, 'isagi.db'),
      statePath: join(root, 'state.json'),
      worktreesPath: join(root, 'worktrees'),
      sessionsPath: join(root, 'sessions'),
      ...overrides,
    },
  };
}
