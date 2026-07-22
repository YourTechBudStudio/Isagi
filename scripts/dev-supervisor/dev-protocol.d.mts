export const developmentProtocolVersion: 1;
export const runtimeLogPrefix: 'ISAGI_DEV_LOG ';
export const webReadinessPrefix: 'ISAGI_WEB_READY ';
export const developmentEnvironmentKeys: Readonly<{
  worktreeRoot: 'ISAGI_DEV_WORKTREE_ROOT';
  processOwner: 'ISAGI_DEV_PROCESS_OWNER';
  desktopLogMode: 'ISAGI_DESKTOP_LOG_MODE';
  webUrl: 'ISAGI_WEB_URL';
}>;
export const privateRuntimeEnvironmentKeys: readonly string[];
export interface DevelopmentPaths {
  readonly root: string;
  readonly dataRoot: string;
  readonly userData: string;
  readonly lock: string;
  readonly desktopRoot: string;
  readonly runtimeStage: string;
}
export function developmentPaths(root: string): DevelopmentPaths;
export function formatRuntimeLogRecord(record: {
  readonly stream: 'stdout' | 'stderr';
  readonly payload: string;
}): string;
export function formatWebReadiness(record: {
  readonly mode: 'dev' | 'preview';
  readonly url: string;
}): string;
