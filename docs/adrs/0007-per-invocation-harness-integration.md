# 0007-per-invocation-harness-integration

status: accepted
date: 2026-06-15
updated: 2026-06-22

## Decision

Isagi harness integrations must not mutate global, user, or project harness configuration as part of launching, restoring, observing, or instrumenting an agent session.

Harness adapters may inject hooks, extensions, plugins, environment variables, runtime-owned config files, and command-line flags only through the process invocation envelope for the harness process Isagi launches. Any generated integration artifacts must live under Isagi runtime-owned data paths or other explicit temporary/runtime-owned locations.

Isagi observes a launched session — its attention state, turn lifecycle, and conversation history — entirely from the durable artifacts those launches produce, interpreted at read time. The per-session harness event ledger stores the raw, unmodified native harness event inside Isagi's envelope; Isagi performs all normalization in per-harness parsers at read time and never reshapes the native event at write time.

Where a harness exposes content only through its own native artifacts rather than the injected instrumentation — for example, an assistant transcript — adapters may read those artifacts read-only, scoped to the sessions Isagi launched. Such reads are best-effort and depend on harness-native formats and locations; a missing or unreadable artifact must surface as degraded or empty rather than as fabricated history.

Harness session ID capture and resume behavior are adapter-owned and best-effort. When a harness cannot provide the needed metadata or cannot be instrumented per invocation, Isagi must surface degraded diagnostic state rather than pretending restoration is guaranteed.

## Motivation

Agent harnesses such as Pi, OpenCode, Claude Code, and Codex can expose session IDs, resume commands, hooks, plugins, extensions, or config mechanisms. Those integration points are necessary for robust agent-session restoration, but global or project-level mutation would leak Isagi behavior into the user's normal harness usage outside Isagi.

Users should be able to run their harnesses directly without Isagi-installed hooks changing behavior, collecting metadata, altering prompts, or changing tool policies. The runtime should own the launch envelope for processes it starts and keep integration effects scoped to those processes.

Storing only raw native events keeps the ledger debuggable and reviewable, concentrates interpretation in a single read-time path, prevents a write-time parser from corrupting the durable record, and lets automated tests run against real captured events. Reading a harness's own native artifact is sometimes the only way to reconstruct content the harness does not surface through hooks; keeping those reads read-only and scoped to Isagi-launched sessions preserves the same non-invasive guarantee the injection rules provide.

## Consequences

- Runtime adapters own harness-specific launch and resume envelopes: executable, args, cwd, env, generated config paths, and hook/plugin/extension injection.
- Runtime integration code must not write to global user config such as harness home directories for persistent setup unless a future explicit user-approved feature changes this ADR.
- Runtime integration code must not write project-local harness config as an implicit side effect of launching or restoring an agent session.
- Generated hook, plugin, extension, or config files must be traceable to Isagi runtime-owned state and safe to clean up.
- Adapter behavior should be explicit about what metadata it can capture, which resume command it can build, and which degraded states are possible.
- Unsupported or unvalidated harness integration paths require diagnostics and validation spikes before being treated as reliable restoration behavior.
- Contracts and UI should represent degraded restoration with stable codes or states. User-facing copy remains web-owned; runtime messages are diagnostics.
- Per-harness read-time parsers own all interpretation of observed state — attention, turn lifecycle, and conversation — while the ledger stays a faithful, inspectable, migratable native record.
- Read-side parsers that depend on harness-native artifact formats must parse defensively and tolerate version drift; a missing or unreadable artifact yields degraded or empty output, never fabricated content.

## Notes

Per-invocation integration paths are validated for the supported harnesses, each capturing attention, turn lifecycle, and conversation:

- Pi: a per-run extension.
- OpenCode: a per-run plugin.
- Claude Code: per-run command hooks for turn lifecycle, plus read-only reconstruction of conversation from the native transcript the launch produces.
- Codex: per-run command hooks via process-scoped config overrides; the earlier hook-schema validation spike is resolved.

The specific hook and event names per harness live in the runtime adapters and in the change's decision log, not in this ADR, so the decision stays stable as harness versions evolve.
