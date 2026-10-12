# Isagi CLI

- The runtime owns state. The CLI reads no SQLite, no data-root paths and runs no Git.
- With `--json`, stdout carries exactly one JSON document; progress goes to stderr.
- Any change to commands, flags or CLI error codes (`cliErrorCodeSchema`) ships `isagi-docs` skill coverage in the same change.
- `src/paths.ts` duplicates the runtime's `canonicalizeProspectivePath`; the two must stay identical.
