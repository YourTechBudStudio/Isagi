# Investigate workflow runs

Use the `isagi` CLI to read what a run did: its tree of graph invocations and executions, the prompts sent and replies received, the files it checkpointed, and its event log. Use `isagi --help` or `isagi <group> <command> --help` for exact syntax. IDs in these examples are placeholders; use values returned by earlier commands. Every ID (run, execution, operation, checkpoint) is global, so a command that names one needs no `--run`.

## Runtime and output

Isagi-launched terminals and agents receive `isagi` on `PATH` and `ISAGI_RUNTIME_URL`. `--runtime-url <url>` overrides that address. Use a plain HTTP(S) URL without credentials. Run on the runtime's machine; export writes on that machine's filesystem.

If the command is missing, use an Isagi terminal or `{{DATA_ROOT}}/tools/isagi-cli/<version>/bin/isagi` with `--runtime-url`. Legacy tmux terminals may also need this. After a runtime restart, open a new terminal if its old address no longer answers. Respect the active harness's network and write permissions; use its supported approval mechanism if available, otherwise report the blocked access.

Every command prints one JSON document. With `--json` it is a single line: the result, or `{ "error": { code, reason?, message, requestId?, data? } }`; without it the same document is indented and an error is one line on stderr. `checkpoints read` is the exception: it writes the file's raw bytes to stdout and errors to stderr. Exit status is 0 for success, 1 for a runtime or local failure, and 2 for a command line the CLI refused.

## What the records are

- **`runs show <run>`** returns `{ run, inputs, invocations, executions }`. `invocations` are graph entries (the root graph once, each subgraph visit once) and `executions` are node runs, both flat and linked by ids: an execution's `invocationId`, a subgraph execution's `childInvocationId`, a Retry's `retryOf`. `run.current` is where a live run is parked.
- **`executions show <execution>`** returns what the node returned (`result`), what came back (`event`), where its edge went (`decision`), the graph state after the step (`stateAfter`), any `error` (with the `stage` and the graph and node whose code threw), its operations and its `checkpointId`.
- **Operations** are every side-effecting call a node made, in order: `spawn_agent`, `send_prompt`, `run_headless`, `close_pane`. `request.prompt` is the full prompt as sent; `responseText` is the agent's last reply for that turn, or a headless job's output. A null `responseText` on a finished prompt means the reply could not be read, and the run logged a warning. Operations are history only: a Retry that runs a node again logs new ones.
- **Events** (`runs events`) are the run's append-only log: node starts, waits, deliveries and failures, pauses and resumes, `code_reloaded`, `run_retried`, checkpoints, environment steps, `log` and `ui_feedback` entries.

## Pagination

`runs list`, `runs events`, `operations list` and `checkpoints list` are paginated. Follow `nextCursor` with `--cursor`, keeping filters unchanged, until it is null. Use `--limit` to bound each page. `workflows list` returns `{ origin, workflows }` in one document.

## Worked example: a planner and implementer postmortem

Question: was the planner↔implementer conversation in run 42 fruitful, and how many times did the plan change?

```sh
isagi runs list --workflow plan-and-implement --json
isagi runs show 42 --json
```

Find the run, then read its tree. Count the executions of the planning and implementing nodes, note which ones have `retryOf` set, and read the `agentSessionId` of each conversation from the operations of the execution that spawned it:

```sh
isagi executions show 137 --json
isagi operations list --run 42 --session 9 --json
isagi operations show 31 --json
```

`operations list --session 9` is one agent's side of the dialogue, in order: each `send_prompt` has the prompt Isagi sent and the reply the agent gave. Drop `--session` to read every agent in the run interleaved by time; add `--execution` to read one node's calls. Use `operations show` for one operation in full, including harness, model, effort, usage and timing.

### Compare plan versions

```sh
isagi checkpoints list --run 42 --scope plan --json
isagi checkpoints show 5 --json
isagi checkpoints read 5 work/plan/plan.md
isagi checkpoints read 8 work/plan/plan.md
```

Every checkpoint that captured the `plan` scope is one saved version of the plan. `checkpoints show` lists each scope's files with their `sha256`; two versions whose hashes match did not change. Read two versions and compare them yourself; there is no diff command. A scope marked `missing` did not exist when that checkpoint was taken.

### Pauses, reloads and retries

```sh
isagi runs events 42 --json
isagi runs structure 42 --json
isagi runs structure 42 --artifact-hash sha256:3b1f0e9d2c4a5b6c7d8e9f00112233445566778899aabbccddeeff0011223344 --json
```

Events show when the run was paused and resumed, when Resume or Retry reloaded newer code (`code_reloaded`, with the old and new build hashes), what each Retry repeated (`run_retried`), and every warning the run logged. Each execution names the `artifactHash` of the build that ran it; `runs structure --artifact-hash` shows that build's declared graph.

Treat start and end times as elapsed time: look at waits and pauses before attributing time to model work. Unknown usage values are not zero.

## Controls

```sh
isagi runs pause 42 --json
isagi runs resume 42 --json
isagi runs retry 42 --json
isagi runs cancel 42 --json
```

Read [Workflow recovery](workflow-recovery.md) before choosing a control: Resume and Retry both reload the latest verified build of the workflow, and refuse if it no longer fits where the run is parked. Each returns `{ run }`, the run's summary after the control. Answering a wait and dismissing a run are not CLI commands; they happen in the Isagi app.

## Troubleshooting

Runtime failures keep their code, reason, request ID and diagnostic data. The failures the CLI itself reports:

| Code | Action |
| --- | --- |
| `cli_usage_invalid` | Check `--help` for the command, its flags and paired flags. |
| `runtime_unconfigured` | Supply `--runtime-url` or use an Isagi terminal. |
| `runtime_unreachable` | Check the runtime address and access. For `checkpoints read`, stdout may be truncated. |
| `runtime_response_invalid` | Report the invalid response with its request context. |
| `origin_unresolved` | Supply launch `--worktree` (and `--surface` if the origin needs one). |
| `filesystem_write_failed` | Writing to stdout failed; check the reported `errno`. |

Report retrieved facts and unavailable data explicitly. Choose comparison scope and criteria with the user; workflow keys alone do not establish comparable runs.
