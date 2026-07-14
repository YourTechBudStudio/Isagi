import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSupervisorLogRecord, supervisorRecordPrefix } from './logging.js';

test('supervisor framing round-trips ANSI and line endings losslessly', () => {
  const payload = '\u001b[36mruntime\u001b[0m\r\n';
  const framed = formatSupervisorLogRecord({ stream: 'stderr', payload });
  assert.ok(framed.startsWith(supervisorRecordPrefix));
  const record = JSON.parse(framed.slice(supervisorRecordPrefix.length)) as {
    stream: string;
    encoding: string;
    payload: string;
  };
  assert.equal(record.stream, 'stderr');
  assert.equal(record.encoding, 'base64');
  assert.equal(Buffer.from(record.payload, 'base64').toString('utf8'), payload);
});
