import {
  isagiDataDirectoryPaths,
  type DataDirectoryService,
  type IsagiDataDirectory,
} from './data-directory.service.js';

/**
 * Builds a {@link DataDirectoryService} stub rooted at `root`, deriving the standard child paths
 * through the **product's own** derivation. Pass `overrides` to point an individual path elsewhere
 * (e.g. a custom worktrees parent).
 *
 * Delegating rather than restating it is what lets a test prove something about path derivation at
 * all: the root is canonicalized here because `isagiDataDirectoryPaths` canonicalizes it, so a test
 * whose subject is "an Isagi-derived path agrees with the one Git reports" fails if that
 * canonicalization is ever removed, instead of passing on a normalization the fixture applied
 * itself.
 */
export function makeTestDataDirectory(
  root: string,
  overrides: Partial<IsagiDataDirectory> = {},
): DataDirectoryService {
  return { paths: { ...isagiDataDirectoryPaths(root), ...overrides } };
}
