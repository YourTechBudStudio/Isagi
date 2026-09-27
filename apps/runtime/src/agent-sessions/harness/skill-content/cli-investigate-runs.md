# Investigate workflow runs

Use the `isagi` CLI to read retained run facts and selected content. Use `isagi --help` or `isagi <group> <command> --help` for exact syntax. IDs in these examples are placeholders; use values returned by earlier commands.

## Runtime and output

Isagi-launched terminals and agents receive `isagi` on `PATH` and `ISAGI_RUNTIME_URL`. `--runtime-url <url>` overrides that address. Use a plain HTTP(S) URL without credentials. Run on the runtime's machine; reconstruction requires shared filesystem access.

If the command is missing, use an Isagi terminal or `{{DATA_ROOT}}/tools/isagi-cli/<version>/bin/isagi` with `--runtime-url`. Legacy tmux terminals may also need this. After a runtime restart, open a new terminal if its old address no longer answers. Respect the active harness's network/write permissions; use its supported approval mechanism if available, otherwise report the blocked access.

`--json` prints one result or `{ error: { code, reason?, message, requestId?, data? } }`; diagnostics go to stderr. Exceptions: `evidence read` writes raw bytes and sends errors to stderr; checkpoint export returns its own status document, described in [CLI reconstruction](cli-reconstruct-and-launch.md#check-the-result). Exit status is 0 for success, 1 for runtime/local failure, and 2 for rejected command syntax.

## Pagination

Run history, version, execution, attempt, operation, evidence, and checkpoint lists are paginated. Follow `nextCursor` with `--cursor`, keeping filters unchanged, until null. Use `--limit` to bound each page. `workflows list` instead returns `{ origin, workflows }`. Checkpoint inspection with `--resolved` or `--manifest`, and checkpoint export, follow their pages automatically.

## Worked example: investigate phase 2

```sh
isagi runs list --workflow implement-story --json
isagi runs inspect 42 --json
isagi executions list --run 42 --node phase --json
isagi executions list --run 42 --frame 9 --json
isagi executions inspect 151 --run 42 --json
isagi attempts list --run 42 --execution 151 --json
isagi operations list --run 42 --execution 151 --json
isagi operations inspect wop_5b2d0c1e-3f5a-4c1e-9a7b-2f4d8e6c1a90 --run 42 --json
```

Choose a run, then find the phase's visit. A subgraph execution names its child frame; list that frame to descend as deeply as needed. In this example phase 2 names frame 9, which contains execution 151. Inspect its attempts and operations to distinguish repeated visits, retries, and external work.

`runs inspect` returns `{ run, rootFrame }`; root `parametersRef` holds launch inputs. Payloads are inline or carry a `payloadRef` for a separate read:

```sh
isagi payloads read sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 --run 42 --json
isagi runs events 42 --json
isagi runs versions 42 --json
isagi runs structure 42 --json
isagi runs structure 42 --artifact-hash sha256:3b1f0e9d2c4a5b6c7d8e9f00112233445566778899aabbccddeeff0011223344 --json
```

Events identify pauses and Retry version changes; inspect historical structure using its artifact hash. Label start/end durations as elapsed time: examine waits, pauses, and attempts before attributing time to model work. Operation detail provides available harness, requested model/effort, usage, and native transcript references. Unknown values are not zero; transcript availability can change.

## Evidence and checkpoints

```sh
isagi evidence list --run 42 --execution 140 --descendants --role review-feedback --label round:2 --json
isagi evidence inspect wev_0f8e2a64-6d0b-4f4c-8a51-5d6f2b9c7e13 --run 42 --json
isagi evidence read wev_0f8e2a64-6d0b-4f4c-8a51-5d6f2b9c7e13 --run 42
isagi evidence export wev_0f8e2a64-6d0b-4f4c-8a51-5d6f2b9c7e13 --run 42 --output ./review-round-2.md --json
isagi checkpoints list --run 42 --execution 140 --descendants --json
```

`--execution` selects a visit; `--descendants` includes nested executions. List metadata before retrieving selected bodies. Evidence labels combine as filters and compare text representations, so do not rely on scalar type to distinguish labels. Follow `source.operationKey` to the producer; the evidence record's own `operationKey` identifies capture.

Evidence export requires a new output file. A failed raw read may leave truncated stdout; check exit status. Missing/corrupt content is distinct from a missing record. For checkpoint coverage and export, use [CLI reconstruction](cli-reconstruct-and-launch.md).

## Controls

```sh
isagi runs pause 42 --json
isagi runs resume 42 --json
isagi runs retry 42 --json
isagi runs cancel 42 --json
```

Read [Workflow recovery](workflow-recovery.md) before choosing a control: Resume uses saved code; Retry may adopt a newer verified build. Inspect the returned control result. Answering a wait and dismissing a run are not CLI commands.

## Troubleshooting

Runtime failures preserve their code, reason, request ID, and diagnostic data. CLI-owned failures:

| Code | Action |
| --- | --- |
| `cli_usage_invalid` | Check command help and flag combinations. |
| `runtime_unconfigured` | Supply the runtime URL or use an Isagi terminal. |
| `runtime_unreachable` | Check runtime address/access; a content stream may be partial. |
| `runtime_response_invalid` | Report the invalid response and request context. |
| `origin_unresolved` | Supply launch `--worktree` and `--surface` together. |
| `output_exists` | Choose a new evidence output file. |
| `filesystem_write_failed` | Check the reported path and `errno`. |
| `content_integrity_mismatch` | Treat the export as failed; captured bytes did not match declared integrity/size. |
| `export_destination_rejected` | Choose an absent/empty directory outside checkouts; inspect `destinationIssue`. |
| `export_destination_not_visible` | Run on the runtime's machine; inspect the worktree already created. |
| `export_path_unsafe` | Inspect unsafe paths or symlink parents; do not bypass containment. |
| `export_path_conflict` | Inspect file/directory conflicts in the partial destination. |
| `export_inventory_conflict` | Report conflicting inventory entries. |

Report retrieved facts and unavailable data explicitly. Choose comparison scope and criteria with the user; workflow keys alone do not establish comparable runs.
