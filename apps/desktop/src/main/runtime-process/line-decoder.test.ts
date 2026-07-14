import assert from 'node:assert/strict';
import test from 'node:test';

import { LosslessLineDecoder } from './line-decoder.js';

test('lossless decoder preserves chunk-split lines, CRLF, ANSI, and final partial content', () => {
  const decoder = new LosslessLineDecoder();
  assert.deepEqual(decoder.write(Buffer.from('\u001b[35mhel')), []);
  assert.deepEqual(decoder.write(Buffer.from('lo\u001b[0m\r\nnext\npartial')), [
    { payload: '\u001b[35mhello\u001b[0m', ending: '\r\n' },
    { payload: 'next', ending: '\n' },
  ]);
  assert.deepEqual(decoder.end(), [{ payload: 'partial', ending: '' }]);
  assert.deepEqual(decoder.end(), []);
});
