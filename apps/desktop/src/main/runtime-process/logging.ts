import process from 'node:process';

export type RuntimeLogStream = 'stdout' | 'stderr';

export interface RuntimeLogRecord {
  readonly stream: RuntimeLogStream;
  readonly payload: string;
}

export type RuntimeLogSink = (record: RuntimeLogRecord) => void;

const supervisorRecordPrefix = 'ISAGI_DEV_LOG ';

export function createRuntimeLogSink(
  mode: 'human' | 'supervisor' = process.env.ISAGI_DESKTOP_LOG_MODE === 'supervisor'
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
  return `${supervisorRecordPrefix}${JSON.stringify({
    protocolVersion: 1,
    source: 'runtime',
    stream,
    encoding: 'base64',
    payload: Buffer.from(payload, 'utf8').toString('base64'),
  })}`;
}

export { supervisorRecordPrefix };
