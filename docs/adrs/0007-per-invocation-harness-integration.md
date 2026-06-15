# 0007-per-invocation-harness-integration

status: accepted
date: 2026-06-15

## Decision

Isagi harness integrations must not mutate global, user, or project harness configuration as part of launching, restoring, observing, or instrumenting an agent session.

Harness adapters may inject hooks, extensions, plugins, environment variables, runtime-owned config files, and command-line flags only through the process invocation envelope for the harness process Isagi launches. Any generated integration artifacts must live under Isagi runtime-owned data paths or other explicit temporary/runtime-owned locations.

Harness session ID capture and resume behavior are adapter-owned and best-effort. When a harness cannot provide the needed metadata or cannot be instrumented per invocation, Isagi must surface degraded diagnostic state rather than pretending restoration is guaranteed.

## Motivation

Agent harnesses such as Pi, OpenCode, Claude Code, and Codex can expose session IDs, resume commands, hooks, plugins, extensions, or config mechanisms. Those integration points are necessary for robust agent-session restoration, but global or project-level mutation would leak Isagi behavior into the user's normal harness usage outside Isagi.

Users should be able to run their harnesses directly without Isagi-installed hooks changing behavior, collecting metadata, altering prompts, or changing tool policies. The runtime should own the launch envelope for processes it starts and keep integration effects scoped to those processes.

## Consequences

- Runtime adapters own harness-specific launch and resume envelopes: executable, args, cwd, env, generated config paths, and hook/plugin/extension injection.
- Runtime integration code must not write to global user config such as harness home directories for persistent setup unless a future explicit user-approved feature changes this ADR.
- Runtime integration code must not write project-local harness config as an implicit side effect of launching or restoring an agent session.
- Generated hook, plugin, extension, or config files must be traceable to Isagi runtime-owned state and safe to clean up.
- Adapter behavior should be explicit about what metadata it can capture, which resume command it can build, and which degraded states are possible.
- Unsupported or unvalidated harness integration paths require diagnostics and validation spikes before being treated as reliable restoration behavior.
- Contracts and UI should represent degraded restoration with stable codes or states. User-facing copy remains web-owned; runtime messages are diagnostics.

## Notes

Current local research suggests process-scoped integration paths exist for the supported harnesses:

- Pi can use per-run extensions and session flags.
- OpenCode can use per-run config content and plugins.
- Claude Code can use per-run settings and resume flags.
- Codex can use per-run config overrides and resume flags, though hook schema validation still needs a dedicated spike.

These observations support the direction, but adapter implementations should validate the exact launch envelopes before relying on each harness path.
