import type { WorkflowOperationUsage } from '@isagi/contracts';

import { parseClaudeHeadlessResult } from '../headless-output.js';

/**
 * What Claude reported about a headless run it just finished.
 *
 * Field names confirmed against the installed CLI (`claude --print --output-format json`, 2.1.277):
 * the result object carries `session_id`, `total_cost_usd`, and a `usage` object holding
 * `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`.
 *
 * Every field is read independently and tolerantly, so a CLI that renames or drops one degrades
 * that field alone rather than discarding the whole record. Nothing is computed: `inputTokens` is
 * the bare *uncached* input, which for a cached prompt is dwarfed by the two cache counts — a run
 * that read 10k cached tokens and wrote 10k more reports `input_tokens: 2`. Recording all four
 * verbatim is what lets a reader see that relationship instead of being handed a figure the
 * provider never reported. `costUsd` is Claude's own charge and is the one number that already
 * accounts for caching.
 */
export function extractClaudeHeadlessProvenance(raw: string): {
  readonly harnessSessionId: string | null;
  readonly usage: WorkflowOperationUsage | null;
} {
  const result = parseClaudeHeadlessResult(raw);
  if (!result) return { harnessSessionId: null, usage: null };

  const usageFields =
    result['usage'] && typeof result['usage'] === 'object' && !Array.isArray(result['usage'])
      ? (result['usage'] as Record<string, unknown>)
      : {};
  const numberAt = (fields: Record<string, unknown>, key: string) =>
    typeof fields[key] === 'number' && Number.isFinite(fields[key]) ? fields[key] : null;

  const usage: WorkflowOperationUsage = {
    inputTokens: numberAt(usageFields, 'input_tokens'),
    cacheReadInputTokens: numberAt(usageFields, 'cache_read_input_tokens'),
    cacheCreationInputTokens: numberAt(usageFields, 'cache_creation_input_tokens'),
    outputTokens: numberAt(usageFields, 'output_tokens'),
    costUsd: numberAt(result, 'total_cost_usd'),
  };

  return {
    harnessSessionId: typeof result['session_id'] === 'string' ? result['session_id'] : null,
    // All-null usage is reported as no usage at all: a record of five unknowns says nothing that
    // "nothing was reported" does not already say, and pretends the provider answered.
    usage: Object.values(usage).some((value) => value !== null) ? usage : null,
  };
}
