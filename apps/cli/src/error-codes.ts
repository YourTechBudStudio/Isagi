import { Schema } from 'effect';

/**
 * The failures the CLI itself names. Every other code in an error document is the runtime's own,
 * passed through from its envelope unchanged. Each literal is documented in the shipped skill, which
 * a test enforces.
 */
export const cliErrorCodeSchema = Schema.Literal(
  'cli_usage_invalid',
  'runtime_unconfigured',
  'runtime_unreachable',
  'runtime_response_invalid',
  'origin_unresolved',
  'filesystem_write_failed',
);

export type CliErrorCode = typeof cliErrorCodeSchema.Type;
