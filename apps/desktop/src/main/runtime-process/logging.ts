import process from 'node:process';

import {
  developmentEnvironmentKeys,
  formatRuntimeLogRecord,
  runtimeLogPrefix as supervisorRecordPrefix,
} from '../../../../../scripts/dev-supervisor/dev-protocol.mjs';

export type RuntimeLogStream = 'stdout' | 'stderr';

export interface RuntimeLogRecord {
  readonly stream: RuntimeLogStream;
  readonly payload: string;
}

export type RuntimeLogSink = (record: RuntimeLogRecord) => void;

export function createRuntimeLogSink(
  mode: 'human' | 'supervisor' = process.env[developmentEnvironmentKeys.desktopLogMode] ===
  'supervisor'
    ? 'supervisor'
    : 'human',
): RuntimeLogSink {
  if (mode === 'supervisor') {
    return ({ stream, payload }) => {
      process.stdout.write(`${formatSupervisorLogRecord({ stream, payload })}\n`);
    };
  }

  return ({ stream, payload }) => {
    const destination = stream === 'stderr' ? process.stderr : process.stdout;
    destination.write(`[runtime] ${payload}`);
  };
}

export function formatSupervisorLogRecord({ stream, payload }: RuntimeLogRecord) {
  return formatRuntimeLogRecord({ stream, payload });
}

export { supervisorRecordPrefix };
