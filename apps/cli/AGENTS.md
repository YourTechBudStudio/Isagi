# Isagi CLI

- The runtime owns state. The CLI reads no SQLite, no data-root paths and runs no Git; work such as `checkpoints export` is one runtime call.
- With `--json`, stdout carries exactly one JSON document; progress goes to stderr.
- Every CLI-owned error code is listed in `cliErrorCodeSchema` and documented in the shipped `isagi-docs` skill.
- Any change to commands or flags ships skill coverage in the same change.
- `src/paths.ts` duplicates the runtime's `canonicalizeProspectivePath`; the two must stay identical.
- Output goes through `CliContext`, never globals such as `console` or `process.stdout`, so tests can run the whole CLI in process.
