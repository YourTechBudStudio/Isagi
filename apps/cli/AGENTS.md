# Isagi CLI

## What this is

`isagi`, the command-line client agents use to investigate workflow runs through the runtime API. Isagi puts it on `PATH` and sets `ISAGI_RUNTIME_URL` in every terminal and agent session it launches; the runtime ships `dist/isagi.mjs` as an asset and writes a shim that runs it.

## Structure

- `src/commands/table.ts` is the command table and parser: pure data, no IO. `--help`, validation and the shipped skill's agreement test all read it (exported as `@isagi/cli/commands`).
- `src/commands/index.ts` maps every command id to its handler; its type forces exactly one handler per table entry.
- `src/runtime-api.ts` is the `RuntimeApi` service over `@isagi/runtime-client`.
- `src/main.ts` (`runCli(argv, io)`) is the in-process test seam; `src/bin.ts` is the process boundary.
- `src/content-stream.ts` streams a content route's bytes (`checkpoints read`) to stdout, telling a broken download from a failed write.
- `src/paths.ts` duplicates the runtime's `canonicalizeProspectivePath` for origin resolution; the two must stay identical.

## Rules

- The runtime owns state. The CLI reads no SQLite, no data-root paths, and runs no Git. `checkpoints export` is one runtime call; the runtime checks the folder and writes every file.
- One route is one command, except `workflows list` and `runs launch`, which first resolve the origin.
- With `--json`, stdout carries exactly one JSON document; progress goes to stderr.
- Every CLI-owned error code is listed in `cliErrorCodeSchema` and documented in the shipped `isagi-docs` skill.
- Value rules come from `@isagi/contracts`; do not restate them.
- Any change to commands or flags ships skill coverage in the same change.
