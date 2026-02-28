# Resources Model (MVP)

**Last updated:** 2026-02-26

This document is the canonical durable output model for the MVP.

## Why resources replace artifact-centric outputs in MVP

MVP uses a single durable output model: resources.

Reasons:

- simpler than multi-type artifact contracts while still covering code + docs
- git-backed durability with reviewable history
- avoids a separate global durable store as an MVP dependency

## Definitions

### Resource

A resource is a durable, git-backed unit of knowledge or code that the system can load as context and that sessions can safely edit.

### Resource kinds (v1)

Conceptual kinds (v1):

- `git_repo` - a resource whose root is a git repo clone
- `directory` - a folder inside an owning git repo
- `document` - a file inside an owning git repo

### Ownership

A resource is owned by exactly one container:

- area-owned, or
- project-owned

Ownership is exclusive; a resource is not shared across multiple owners in v1.

## Identity and paths

### Identity

`resource_id` is the identity. Paths are derived from ownership + naming rather than stored as canonical identity.

### Naming constraints

- resource names must be unique within their owner container (area or project)
- duplicate git URLs are allowed (multiple resources may point to the same remote)

### Workspace locations (derived)

Derived locations under a single workspace root:

- area-owned: `workspace/areas/<area-id>/resources/<resource-name>/...`
- project-owned: `workspace/areas/<area-id>/projects/<project-id>/resources/<resource-name>/...`

## Git backing and area storage modes

v1 supports only git-backed resources.

Each area declares one fixed storage mode:

- `area_monorepo`: an area-level repo is canonical; `directory`/`document` resources live inside that repo
- `resource_repos`: resources are typically `git_repo` roots (each resource is its own repo clone); projects may be scaffold-only containers

Multiple resources may be backed by the same remote URL.

## Lifecycle

### Creation (v1 constraint)

Resources are created by humans or project templates in v1. Agents can propose changes that result in resource creation, but do not create resources directly during execution sessions.

### Mutation

Agents can edit resource contents under the MVP posture of safe-by-review.

### Attach/detach

v1 does not support attaching/detaching resources or linking shared resources across owners.

## Deletion semantics

- soft delete in the database (tombstone)
- local workspace data removed on area/project delete
- remotes may persist (for example GitHub)
- task/session history may reference deleted resources

## Provenance (v1)

Each resource record carries minimal provenance metadata used for scoping and retrieval. Conceptually:

- ownership: area-owned vs project-owned
- owner identity: `area_id` and optional `project_id`
- optional origin links: `spark_id` and/or `task_id` (when a resource was created as part of a workflow)
- creation source identifiers (for auditability)

Provenance is used to:

- load the right resources by default when opening a task/session
- filter/search resources within an area/project context
- explain why a resource was included in context

## Indexing and source of truth (v1)

- resource contents in git-backed working copies are the source of truth
- any search index is derived from those working copies and can be rebuilt

## Non-goals (v1)

- access-control enforcement beyond safe-by-review
- non-git resources (agentfs/juicefs/etc)
- resource attach/detach and shared-resource linking
