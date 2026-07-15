import {
  developmentProtocolVersion,
  parseDevelopmentControl,
} from '../../../../scripts/dev-supervisor/dev-protocol.mjs';

export function isRuntimeStageReadyControl(line: string): boolean {
  const record = parseDevelopmentControl(line);
  if (!record) return false;
  if (record.protocolVersion !== developmentProtocolVersion || record.runtimeStage !== 'ready') {
    throw new Error('Unsupported development control record.');
  }
  return true;
}
