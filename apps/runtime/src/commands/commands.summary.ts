import type { CommandStatus, CommandSummary } from '@isagi/contracts';

import type { ResolvedPortEntry } from './commands.ports.js';

// The one place resolved-port metadata becomes a wire summary.
//
// Every command summary the runtime emits — configured, removed, managed, and
// each action output — goes through here, so the while-running gate, the
// null-versus-empty boundary, and the URL formula cannot drift between callers.

// The URL formula, in one place. A future host-aware story changes this line and
// nothing else; clients never reassemble a URL from `{ port, path }`.
export function composeCommandPortUrl(port: number, path: string): string {
  return `http://localhost:${port}${path}`;
}

export function buildCommandSummary(input: {
  readonly name: string;
  readonly status: CommandStatus;
  // The state row's snapshot, or the resolution a launch has in hand. Required,
  // never defaulted: each call site owns the question of what this incarnation
  // actually got, and a default would silently degrade the ones that know.
  readonly resolvedPorts: readonly ResolvedPortEntry[] | null;
}): CommandSummary {
  // Resolved ports describe a live incarnation. A stopped, failed, or suspended
  // command has none to report, whatever the durable snapshot still remembers.
  if (input.status !== 'running') {
    return { name: input.name, status: input.status, ports: [] };
  }
  // Running with no snapshot is honest degradation, not "declared no ports":
  // a row that predates the snapshot column, or one whose JSON did not decode.
  if (input.resolvedPorts === null) {
    return { name: input.name, status: input.status, ports: null };
  }
  return {
    name: input.name,
    status: input.status,
    ports: input.resolvedPorts.map((entry) => ({
      port: entry.port,
      envVar: entry.envVar,
      urls: entry.paths.map((path) => ({
        label: path.label,
        path: path.path,
        url: composeCommandPortUrl(entry.port, path.path),
      })),
    })),
  };
}
