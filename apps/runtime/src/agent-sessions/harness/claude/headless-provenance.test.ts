import assert from 'node:assert/strict';
import test from 'node:test';

import { extractClaudeHeadlessProvenance } from './headless-provenance.js';

/**
 * A real `claude --print --output-format json` result, trimmed to the fields this reads.
 *
 * Captured from the installed CLI (2.1.277) at implementation time rather than invented, because
 * the whole value of this extractor is that its field names match a program nobody here controls.
 * The numbers are the real ones from that run, and they are the point: a two-token prompt reports
 * `input_tokens: 2` beside ten thousand cached tokens, which is why nothing here is summed.
 */
const realResult = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: '1c4d7686-7d38-4bb2-a45b-f4fa8235a527',
  total_cost_usd: 0.10535900000000001,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 10019,
    cache_read_input_tokens: 10118,
    output_tokens: 4,
    service_tier: 'standard',
  },
  result: 'ok',
});

test('the Claude extractor reads the session id and all five usage counts verbatim', () => {
  assert.deepEqual(extractClaudeHeadlessProvenance(realResult), {
    harnessSessionId: '1c4d7686-7d38-4bb2-a45b-f4fa8235a527',
    usage: {
      inputTokens: 2,
      cacheReadInputTokens: 10118,
      cacheCreationInputTokens: 10019,
      outputTokens: 4,
      costUsd: 0.10535900000000001,
    },
  });
});

/**
 * The captured stream is not guaranteed to be only JSON.
 *
 * An observed run led with `Warning: claude.ai MCP servers blocked by enterprise policy: …` on the
 * same captured output, so an extractor that assumed the whole capture parses would have reported
 * nothing at all for a perfectly ordinary run.
 */
test('the Claude extractor finds its result behind unrelated leading output', () => {
  const noisy = `Warning: claude.ai MCP servers blocked by enterprise policy: X, Y\n${realResult}`;
  assert.equal(
    extractClaudeHeadlessProvenance(noisy).harnessSessionId,
    '1c4d7686-7d38-4bb2-a45b-f4fa8235a527',
  );
});

/**
 * Tolerance, field by field.
 *
 * A CLI that renames or drops one field must cost that field alone, not the whole record — these
 * are exactly the runs where provenance is most worth having.
 */
test('absent, non-numeric and unparsable fields degrade individually', () => {
  const partial = extractClaudeHeadlessProvenance(
    JSON.stringify({ session_id: 'abc', total_cost_usd: 'free', usage: { output_tokens: 7 } }),
  );
  assert.deepEqual(partial, {
    harnessSessionId: 'abc',
    usage: {
      inputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      outputTokens: 7,
      costUsd: null,
    },
  });

  // Nothing reported at all is reported as nothing, not as a record of five unknowns: an all-null
  // usage object would claim the provider answered when it did not.
  assert.deepEqual(extractClaudeHeadlessProvenance(JSON.stringify({ session_id: 'abc' })), {
    harnessSessionId: 'abc',
    usage: null,
  });
  assert.deepEqual(extractClaudeHeadlessProvenance('not json at all'), {
    harnessSessionId: null,
    usage: null,
  });
});
