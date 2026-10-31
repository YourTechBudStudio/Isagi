# Isagi CLI

- The runtime owns state. The CLI reads no SQLite, nothing under the data root and runs no Git. `serve` only resolves the data-root path (flag, env or default) and hands it to the runtime.
- With `--json`, stdout carries exactly one JSON document; progress goes to stderr. The exception is `serve` after it hands off: only CLI-side failures are JSON, and stdout then carries the runtime's log and readiness lines.
- Any change to commands, flags or CLI error codes (`cliErrorCodeSchema`) ships `isagi-docs` skill coverage in the same change.
- `src/paths.ts` duplicates the runtime's `canonicalizeProspectivePath`; the two must stay identical.
