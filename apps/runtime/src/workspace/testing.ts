/**
 * The workspace module's test surface: the live workspace harness, the deletion participant double,
 * and builders other modules' tests use. Never imported by production code.
 */
export {
  liveWorkspaceLayer,
  NoProjectDeletionParticipant,
  runWithLiveWorkspace,
  type LiveWorkspaceOptions,
} from './tests/live-workspace-support.js';
// Internals and builders other modules' tests use; never imported by production code.
export { checkNewDirectory } from './new-directory.js';
export { buildWorkspaceSnapshot } from './snapshot.js';
export { createGitProjectFixture } from './tests/live-git-support.js';
export { directoryTree } from './tests/test-support.js';
