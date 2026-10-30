import type { CliErrorCode } from './error-codes.js';

/**
 * The next concrete step for every failure, written for an agent reading `recovery` in an error
 * document. Usage errors usually carry a sharper step built from the refused line (`usage.ts`); this
 * entry is the fallback.
 */
export const cliRecovery: Readonly<Record<CliErrorCode, string>> = {
  cli_usage_invalid: 'Fix the command line; `--help` on the command shows its usage and examples.',
  runtime_unconfigured:
    'Run inside an Isagi terminal, which sets ISAGI_RUNTIME_URL, or pass --runtime-url with the URL of a running runtime.',
  runtime_unreachable:
    'Check that the runtime at `context.runtimeUrl` is running. If the URL came from ISAGI_RUNTIME_URL in an old terminal, open a new Isagi terminal.',
  runtime_response_invalid:
    "Use the `isagi` on PATH inside an Isagi terminal, which matches its runtime's version.",
  origin_unresolved:
    'Pass --worktree with the origin worktree id (and --surface if the origin needs one).',
  filesystem_write_failed:
    'Check `context.path` and `context.errno`, make the destination writable or choose another, then run the command again.',
  runtime_load_failed:
    'Reinstall the package with the Node version you run it with, so its native modules match; other `isagi` commands keep working.',
};

/** The next step for a runtime API failure, by its envelope code. */
export function runtimeRecovery(code: string): string {
  switch (code) {
    case 'api_route_not_found':
      return "This runtime does not serve that command's route; use the `isagi` on PATH inside an Isagi terminal, which matches its runtime's version.";
    case 'api_request_parsing_failed':
      return "The runtime refused the request's shape; check the command's flags with `--help`, then report `requestId` if they are right.";
    default:
      return 'Read `reason` and `data` for what the runtime refused; correct the request, or report `requestId`.';
  }
}
