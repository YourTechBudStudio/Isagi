# Investigate workflow runs with the `isagi` CLI

The `isagi` CLI reads what Isagi retained about workflow runs: runs, nested executions, attempts, operations, payloads, evidence, and checkpoints. It can also pause, resume, retry, and cancel a run. Every command calls the Isagi runtime's API and prints what the runtime returns, so the retrieved facts are the runtime's own, not a reconstruction from files on disk.

Read [Workflow evidence](workflow-evidence.md) for what evidence is and how a workflow captures it, [Workflow checkpoints](workflow-checkpoints.md) for what a checkpoint saves, and [Workflow recovery](workflow-recovery.md) for what Resume and Retry mean.

## Reaching the runtime

Terminals and agent sessions that Isagi launches have `isagi` on `PATH` and the runtime's address in `ISAGI_RUNTIME_URL`. The CLI uses `--runtime-url <url>` when given, otherwise `ISAGI_RUNTIME_URL`. The URL must be a plain `http:` or `https:` address without credentials. With neither set, a command fails with `runtime_unconfigured`.

The CLI must run on the same machine as the runtime: the runtime listens only on the local loopback address, and some commands write files that the caller then reads.

`isagi: command not found` means the shell was not launched by Isagi, for example an external terminal. Work from an Isagi terminal, or run the CLI by its full path, `{{DATA_ROOT}}/tools/isagi-cli/<version>/bin/isagi`, with `--runtime-url`. With the legacy tmux terminal backend, a new terminal may not receive `isagi` or `ISAGI_RUNTIME_URL`; use the full path and `--runtime-url` there too. A terminal opened before the runtime restarted may hold an address that no longer answers, which fails with `runtime_unreachable`; open a new terminal.

A sandboxed agent harness must allow loopback network access for the CLI to reach the runtime, and write access wherever a command writes a file (`evidence export`). If the sandbox blocks either, ask for approval rather than working around it.

`isagi --help` lists every command; `isagi <group> <command> --help` shows one command's arguments and flags.

## Output, errors, and exit status

- `--json` prints exactly one JSON document on stdout: the result, or `{ "error": { … } }`. Without `--json`, a result prints as indented JSON and a failure prints as one stderr line, `isagi: <code> (<reason>): <message>`.
- stderr carries only diagnostics, never data.
- `evidence read` writes the captured bytes, unchanged, to stdout. Its failures always go to stderr, as a JSON document when `--json` is given.
- Exit status is `0` on success, `1` for a runtime, API, or local failure, and `2` for a command line the CLI refused before calling anything.

The error document is `{ code, reason?, message, requestId?, data? }`. A failure the runtime reported keeps the runtime's `code` (for example `workflow_rejected` or `api_request_decoding_failed`), with the runtime's `data.reason` copied into `reason` and `requestId` and `data` passed through unchanged. The CLI's own codes are:

| Code | Meaning |
| --- | --- |
| `cli_usage_invalid` | The command line was refused before any request: unknown command or flag, a missing argument, an ID that is not a positive integer, a page size outside 1–500, a status that does not exist, or flags that cannot be combined. Exit status `2`. |
| `runtime_unconfigured` | Neither `--runtime-url` nor `ISAGI_RUNTIME_URL` is set. |
| `runtime_unreachable` | The runtime did not answer (`data` names the endpoint, the runtime URL, and the cause), or a content stream from it broke part-way (`data` names the evidence key or output path, and the cause). |
| `runtime_response_invalid` | The runtime's reply did not match the API contract, or broke a rule the CLI checks (a repeated page cursor, a page for a different checkpoint). |
| `output_exists` | `evidence export` was given a file that already exists. Nothing was written. |
| `filesystem_write_failed` | A local write failed: the output file, or stdout for `evidence read` (path `<stdout>`); `data` carries the path and `errno`. A reader that stops early, such as `\| head`, is not a failure. |
| `content_integrity_mismatch` | `evidence export` received a different number of bytes than the record declares; the partial file was removed. |

## Pages

A command that reads a list prints one page, `{ items, nextCursor }`, and takes `--limit <n>` (1–500; the runtime defaults to 100) and `--cursor <cursor>`. Pass the printed `nextCursor` back as `--cursor` to read the next page; `nextCursor: null` means there are no more. A cursor is opaque and bound to its listing and filters, so reuse the same filters with it. Only `checkpoints inspect --resolved` and `--manifest` read every page for you.

## Walk a run

Every ID below is a placeholder; use the IDs the previous command printed.

```sh
isagi runs list --workflow implement-story --status failed --json
isagi runs inspect 42 --json
isagi executions list --run 42 --json
isagi executions list --run 42 --frame 7 --json
isagi executions inspect 137 --run 42 --json
isagi attempts list --run 42 --execution 137 --json
isagi operations list --run 42 --execution 137 --json
isagi operations inspect wop_5b2d0c1e-3f5a-4c1e-9a7b-2f4d8e6c1a90 --run 42 --json
isagi payloads read sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 --run 42 --json
```

- `runs list` lists runs newest first, filtered by `--workflow <key>` and `--status <status>`.
- `runs inspect` prints `{ run, rootFrame }`. The root frame is where every execution descends from; its `parametersRef` holds the run's inputs.
- `executions list` lists one frame's executions: the run's root frame by default, or `--frame <frameId>` for a nested graph. An execution that ran a subgraph names its child frame; pass that frame to descend one level, as deep as the run goes. `--node <nodeId>` keeps only one node's visits. The output adds the `frameId` it listed.
- `executions inspect` prints one execution: status, timing, attempt count, and its payload references.
- `attempts list --execution` lists each attempt of an execution with the workflow version (pin) it ran and its timing, including attempts that ended without a recorded failure.
- `operations list` and `operations inspect` show the recorded effects of an execution: agent turns, headless runs, and evidence captures. `operations inspect` adds provenance: harness, requested model and effort, the native session id, cwd, usage when known, and a native transcript locator with whether it exists now. A `null` usage or model is unknown, not zero.
- A payload reference is either inline (`{ "inline": … }`, already printed where it appears) or sized (`{ "payloadRef": "sha256:…", "byteSize", "mediaType" }`). Read a sized one with `payloads read <payloadRef> --run <runId>`.

### History and definitions

```sh
isagi runs events 42 --json
isagi runs versions 42 --json
isagi runs structure 42 --json
isagi runs structure 42 --artifact-hash sha256:3b1f0e9d2c4a5b6c7d8e9f00112233445566778899aabbccddeeff0011223344 --json
```

- `runs events` pages through the run's history as transitions, including pause intervals and Retry pin adoptions (a Retry that moved the run to a newer workflow version).
- `runs versions` lists every workflow version the run has pinned, in order.
- `runs structure` prints the workflow's graph at the run's current pin, or at the `--artifact-hash` of an earlier one.

### Evidence

```sh
isagi evidence list --run 42 --execution 137 --descendants --role review-feedback --label round:2 --json
isagi evidence inspect wev_0f8e2a64-6d0b-4f4c-8a51-5d6f2b9c7e13 --run 42 --json
isagi evidence read wev_0f8e2a64-6d0b-4f4c-8a51-5d6f2b9c7e13 --run 42
isagi evidence export wev_0f8e2a64-6d0b-4f4c-8a51-5d6f2b9c7e13 --run 42 --output ./review-round-2.md --json
```

- `evidence list` prints metadata only. `--execution <id>` keeps one execution's captures; adding `--descendants` also includes every execution nested beneath it, and requires `--execution`. `--role` and `--label key:value` filter; repeat `--label` for several labels; filters combine.
- `evidence inspect` prints one record: title, role, labels, content kind, media type and size, source, and the capture's placement.
- `evidence read` streams the bytes to stdout. The runtime verifies the stored bytes before sending the first one, so a missing or corrupt capture fails with `workflow_evidence_content_unavailable` and nothing on stdout. If the stream breaks after bytes have started, the command fails with `runtime_unreachable` and stdout may be truncated.
- `evidence export` saves the bytes to `--output <file>`, resolved against the current directory. The file must not exist (`output_exists`); a byte count that differs from the record removes the file and fails with `content_integrity_mismatch`. It prints `{ outputPath, evidence }`. A capture without a source path exports the same way, because `--output` names the file.

A record's `source.operationKey` names the operation that produced the content; follow it with `operations inspect` for that turn's provenance. The record's own `operationKey` names the capture itself.

### Checkpoints

```sh
isagi checkpoints list --run 42 --execution 137 --descendants --json
isagi checkpoints inspect wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --json
isagi checkpoints inspect wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --resolved --json
isagi checkpoints inspect wcp_6a3c9e21-4b7d-4f0a-9c2e-8d1f5b7a3e64 --run 42 --manifest --json
```

- `checkpoints list` takes the same `--execution` and `--descendants` filters as `evidence list`.
- `checkpoints inspect` prints `{ checkpoint }`: metadata, the Git base it was captured over, counts, warning groups, and links. It carries no file bodies.
- `--resolved` adds `inventory`: every entry of the final state, across all pages, in server order. Entries are the captured scopes, the final files (path, size, sha256, and executable bit), the paths that must be absent, and warnings about what was not captured.
- `--manifest` adds `manifest`: the checkpoint's layers as they were recorded, for inspection only. `--resolved` and `--manifest` cannot be combined.

Isagi does not keep a checkpoint's base commit alive. If Git has discarded that commit, or the repository is gone, the checkpoint stays inspectable but its base cannot be restored.

## Controls

```sh
isagi runs pause 42 --json
isagi runs resume 42 --json
isagi runs retry 42 --json
isagi runs cancel 42 --json
```

Each prints the runtime's control result: what was accepted and where the run is now. A control the run's state does not allow fails with `workflow_rejected` and a `reason` naming why. [Workflow recovery](workflow-recovery.md) explains what Resume and Retry do. Dismissing a run and answering a wait are not CLI commands.

## Worked example: investigate phase 2

A phase-wise implementation/review workflow ran each phase as a subgraph: an implementer turn, then review rounds until approval. To find out what happened in phase 2:

```sh
isagi runs list --workflow implement-story --json
isagi runs inspect 42 --json
isagi executions list --run 42 --node phase --json
isagi executions list --run 42 --frame 9 --json
isagi attempts list --run 42 --execution 151 --json
isagi evidence list --run 42 --execution 140 --descendants --role review-feedback --json
isagi evidence read wev_0f8e2a64-6d0b-4f4c-8a51-5d6f2b9c7e13 --run 42
isagi operations inspect wop_5b2d0c1e-3f5a-4c1e-9a7b-2f4d8e6c1a90 --run 42 --json
```

1. `runs list` finds the run by its workflow key; `runs inspect` gives its status and root frame.
2. `executions list --node phase` lists the visits of the `phase` node in the root frame; the second visit (execution 140 here) names the child frame (9) its subgraph ran in.
3. `executions list --frame 9` lists that phase's own executions: the implementer turn, each review round, and any waits, with their timing and attempt counts. Compare durations from each execution's start and end times.
4. `attempts list` on an execution with more than one attempt shows each attempt, its pin, and its timing; `runs events` shows when a Retry adopted a newer pin.
5. `evidence list --execution 140 --descendants` lists every capture made anywhere inside phase 2; `evidence read` retrieves the selected review feedback.
6. `operations inspect` on a capture's `source.operationKey` gives the reviewer turn's harness, model, native session id, and whether its transcript still exists.

Report what the commands returned, and name what was unavailable (for example, a transcript that no longer exists or usage that was not recorded) rather than filling the gap.
