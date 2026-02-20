# Notes Model

**Last updated:** 2026-02-19

## Why notes replace artifacts in MVP

MVP uses a single durable output model: notes.

Reasons:

- simpler than multi-type artifact contracts
- easier retrieval and filtering with provenance tags
- decouples documentation/thinking outputs from code repo commits

## Scoping and taxonomy

Notes are global storage with structured paths.

Canonical taxonomy:

- `global/...`
- `areas/<area-id>/...`
- `areas/<area-id>/projects/<project-id>/...`

Session and provenance metadata can add spark/task-level linkage.

## Session-default note scope

`search_notes` supports explicit scope:

- `project`
- `area`
- `global`

Default search scope follows active session/execution scope.

If a scope parameter is provided explicitly, it overrides session-default scope for that query.

## Read-before-write semantics

Notes enforce read-before-write style update safety.

Expected behavior:

1. read current note content/version
2. apply update intent
3. reject stale writes if note changed since read

Pseudo-contract pattern:

1. `read_note(path) -> { content, revision }`
2. `create_note(...)` or `patch_note(..., expected_revision=revision)`
3. write fails when `expected_revision` is stale

Conflict resolution is handled by user/agent retry with fresh read.

## Suggested note tools (MVP guidance)

Tooling is guidance, not a hard frozen API in this doc.

Suggested capabilities:

- `search_notes`
- `read_note`
- `create_note`
- `patch_note` (replace old string with new string)
- `mkdir_notes`
- `rmdir_notes`
- `ls_notes`

## Provenance tags

Notes should carry provenance metadata for filtering and explainability:

- `spark_id` (optional)
- `area_id`
- `project_id`
- `task_id` (optional)
- creation source/session identifiers

## Indexing and source of truth

- Filesystem note content is source of truth.
- Search index is derived and automatically maintained.
- Reindexing can be automated and/or manually triggered.
