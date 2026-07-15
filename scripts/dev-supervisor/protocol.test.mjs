import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLogPresenter,
  createRecordDecoder,
  parseRuntimeLog,
  parseWebReadiness,
} from './protocol.mjs';

test('record decoder preserves split lines, blanks, carriage returns, and final partial data', () => {
  const records = [];
  const decoder = createRecordDecoder((payload, ending) => records.push({ payload, ending }));
  decoder.write('first\n\nprog');
  decoder.write('ress\rnext\r');
  decoder.write('\npartial');
  decoder.end();
  assert.deepEqual(records, [
    { payload: 'first\n', ending: '\n' },
    { payload: '\n', ending: '\n' },
    { payload: 'progress\r', ending: '\r' },
    { payload: 'next\r\n', ending: '\r\n' },
    { payload: 'partial', ending: '' },
  ]);
});

test('web readiness requires the versioned shape and rejects malformed JSON', () => {
  assert.deepEqual(
    parseWebReadiness(
      'ISAGI_WEB_READY {"protocolVersion":1,"mode":"dev","url":"http://127.0.0.1:1/"}',
    ),
    { protocolVersion: 1, mode: 'dev', url: 'http://127.0.0.1:1/' },
  );
  assert.equal(parseWebReadiness('ordinary output'), undefined);
  assert.throws(() => parseWebReadiness('ISAGI_WEB_READY nope'), /malformed JSON/);
  assert.throws(() => parseWebReadiness('ISAGI_WEB_READYnope'), /malformed framing/);
  assert.throws(
    () => parseWebReadiness('ISAGI_WEB_READY {"protocolVersion":2}'),
    /protocol version 1/,
  );
});

test('runtime framing round-trips ANSI payloads and stream identity', () => {
  const payload = '\u001b[36mhello\u001b[0m\r\n';
  const line = `ISAGI_DEV_LOG ${JSON.stringify({
    protocolVersion: 1,
    source: 'runtime',
    stream: 'stderr',
    encoding: 'base64',
    payload: Buffer.from(payload).toString('base64'),
  })}`;
  assert.deepEqual(parseRuntimeLog(line), { stream: 'stderr', payload });
  assert.throws(() => parseRuntimeLog('ISAGI_DEV_LOG {}'), /protocol version 1/);
  assert.throws(() => parseRuntimeLog('ISAGI_DEV_LOG{}'), /malformed framing/);
});

test('color-disabled presentation strips ANSI without trimming payload', () => {
  let stdout = '';
  let stderr = '';
  const present = createLogPresenter({
    stdout: { write: (value) => (stdout += value) },
    stderr: { write: (value) => (stderr += value) },
    color: false,
  });
  present({ source: 'web', stream: 'stdout', payload: '\u001b[31m red \u001b[0m\n' });
  present({ source: 'runtime', stream: 'stderr', payload: '\n' });
  assert.equal(stdout, '[web]  red \n');
  assert.equal(stderr, '[runtime] \n');
});
