# 0010-row-driven-file-garbage-collection

status: accepted
date: 2026-10-08

## Decision

Actions delete rows; they never delete files the runtime wrote. Deleting a project, worktree, session or process record removes database rows only, and the files those rows pointed at become garbage.

Each area that writes files under the runtime data directory owns one collector for its own root. The collector runs on a timer, reads which entries are live from the rows it owns or reads, and deletes only entries in its root that no row references **and** that are older than the area's grace period. No action, API or user command can trigger a collector.

A grace period alone protects a file only when its writer creates the referencing row before, or shortly after, the file. When a writer can hold files unreferenced for an unbounded time, the area also keeps whatever that writer holds in memory, and whatever it released while a sweep was running, because the sweep's view of rows may predate the row that now references the file. Each area documents why its grace period, and any in-memory hold, covers every live file.

Collectors follow these safety rules:

- A deletion path is the collector's fixed root joined with names listed from that root. Paths stored in rows are never deletion targets.
- Candidates are filtered by the area's naming rule and entry type.
- Every directory from the data directory down to a candidate must be a real directory when it is listed and again when the candidate is removed. Symbolic links and entries of the wrong type are skipped, and nothing is followed through a link at any depth.
- The decide-and-remove step for one entry is synchronous, so it cannot interleave with the area's own writers on the runtime's JavaScript thread.
- Filesystem conditions are logged and reported as results, never thrown. Each collector contains its own failures, so a failed sweep is retried on the next tick.

## Scope

- Files and folders under the runtime data directory only. Files Isagi writes elsewhere, such as the `isagi-docs` skill folders that ADR 0007 permits in harness configuration, are outside this rule.
- Process cleanup is out of scope and unchanged: PTY garbage collection of processes (ADR 0005), command stops and headless process timeouts keep their own rules.
- `worktrees/` is never collected. Isagi-created worktrees stay on disk until the user removes them.
- Not yet collected: `workflow-artifacts/` (the workflow build cache), old `tools/` versions and `$TMPDIR/isagi-editor-*`.

The collected areas today are checkpoint content (`workflow-content/`, including crash-leftover temporary files), agent session folders (`sessions/agent-sessions/`) and shell-integration folders (`sessions/shell-integration/`). Each collector's grace period, timer and in-memory hold are documented next to its code; the PTY log sweep in `pty-processes/service/logs.ts` is the original shape they follow.

## Motivation

Inline file removal leaked. Database cascades delete child rows without running the code that removed their folders, and a failed removal after a committed row delete left files nothing would ever revisit. Deleting a project would have needed to find and remove every file of every cascaded record, inside a request that should only change rows.

Deriving liveness from rows makes the database the single source of truth for which files are needed. It follows ADR 0008: each area owns its files as each service owns its tables, so a workspace action never has to know another area's file layout. It also follows ADR 0002: cleanup runs in a named background lifecycle with visible cost, not hidden inside a user-triggered mutation. ADR 0007's requirement that generated harness files be "safe to clean up" is met for agent session folders by their collector.

A longer grace period was not enough on its own. Checkpoint capture can reuse a stored file and take an unbounded time before its checkpoint row commits, so no grace period guarantees the file survives. The in-memory hold closes that gap without a lock or a timing assumption.

## Consequences

- Disk space is reclaimed with a delay of up to roughly one grace period plus one timer interval, not when the user acts.
- Deletion actions stay row-only and transactional; a failed or repeated action never strands or double-deletes files.
- A new area that writes files under the data directory adds its own collector following these rules, or records why it needs none.
- A writer that creates a file before its referencing row must keep the file young (for example, by refreshing its timestamp when reusing it) or hold it in memory until the row commits.
- Collectors are plain functions on their area's timers with one shared helper (`persistence/orphan-files.ts`). There is no central garbage-collection service or framework.
