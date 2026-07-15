import { resolve } from 'node:path';

export const developmentProtocolVersion = 1;
export const developmentControlPrefix = 'ISAGI_DEV_CONTROL ';
export const runtimeLogPrefix = 'ISAGI_DEV_LOG ';
export const webReadinessPrefix = 'ISAGI_WEB_READY ';

export const developmentEnvironmentKeys = Object.freeze({
  worktreeRoot: 'ISAGI_DEV_WORKTREE_ROOT',
  processOwner: 'ISAGI_DEV_PROCESS_OWNER',
  desktopLogMode: 'ISAGI_DESKTOP_LOG_MODE',
  runtimeStageGate: 'ISAGI_RUNTIME_STAGE_GATE',
  webUrl: 'ISAGI_WEB_URL',
});
export const privateRuntimeEnvironmentKeys = Object.freeze(
  Object.values(developmentEnvironmentKeys),
);

export function developmentPaths(root) {
  const dataRoot = resolve(root, 'data/.isagi');
  return {
    root,
    dataRoot,
    userData: resolve(dataRoot, 'electron-user-data'),
    lock: resolve(dataRoot, 'dev-supervisor.lock'),
    desktopRoot: resolve(root, 'apps/desktop'),
    runtimeStage: resolve(root, 'apps/desktop/.generated/runtime'),
  };
}

export function formatDevelopmentControl(record) {
  return `${developmentControlPrefix}${JSON.stringify({ protocolVersion: developmentProtocolVersion, ...record })}`;
}

export function parseDevelopmentControl(line) {
  if (!line.startsWith(developmentControlPrefix)) return undefined;
  return JSON.parse(line.slice(developmentControlPrefix.length));
}

export function formatRuntimeLogRecord({ stream, payload }) {
  return `${runtimeLogPrefix}${JSON.stringify({ protocolVersion: developmentProtocolVersion, source: 'runtime', stream, encoding: 'base64', payload: Buffer.from(payload, 'utf8').toString('base64') })}`;
}

export function formatWebReadiness({ mode, url }) {
  return `${webReadinessPrefix}${JSON.stringify({ protocolVersion: developmentProtocolVersion, mode, url })}`;
}
