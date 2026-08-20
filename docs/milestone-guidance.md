# Milestone Guidance

This document defines how Isagi's milestones and stories are represented, retrieved, and amended. It is the repository-specific persistence contract used by the `shaping-milestones` skill.

Milestones and stories live in GitHub Issues on `YourTechBudStudio/Isagi`. They are not stored in this repository. This document is the mapping; GitHub is the source of truth.

Read this document before retrieving, creating, or amending any milestone or story. When a task begins with an issue number, follow [Retrieval](#retrieval) before doing anything else.

## Object Model

| Concept                         | GitHub representation                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate milestone             | An issue whose title begins with `[milestone] `, is labeled `Type: Milestone` and `Milestone: Candidate`, and has no stories                                               |
| Committed milestone             | An issue whose title begins with `[milestone] ` and is labeled `Type: Milestone` and `Milestone: Committed`                                                                |
| Story                           | An issue whose title begins with `[story] `, is labeled `Type: Story` and exactly one `Story:*` label, and is attached as a **sub-issue** of its committed milestone issue |
| Story kind                      | `Story: Exploration`, `Story: Implementation`, or `Story: Release`                                                                                                         |
| Milestone ↔ story navigation    | GitHub's native sub-issue relationship                                                                                                                                     |
| Relationship between milestones | A plain issue reference in the body (`Blocked by #12` or `Related to #12`)                                                                                                 |
| Dependency between stories      | A plain issue reference in the body (`Blocked by #12`)                                                                                                                     |
| Exploration consumer            | A plain issue reference in the body (`Feeds #14, #15`)                                                                                                                     |
| Amendment to any shaped object  | A new comment on that issue; established body content is never edited                                                                                                      |
| Spark                           | Not configured. Sparks arrive from an external system that has not been chosen yet. Do not create GitHub objects for them.                                                 |

A shaped issue carries exactly one matching type-and-kind pair. Report missing, mixed, or duplicate classification labels rather than inferring intent. An issue carrying no classification label is outside this system.

## Labels

These seven classification labels are owned by this system.

| Label                   | Meaning                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Type: Milestone`       | The issue is a milestone.                                                                                                                                          |
| `Milestone: Candidate`  | The milestone is an uncommitted, storyless direction preserved for future shaping.                                                                                 |
| `Milestone: Committed`  | The milestone is hardened and may have stories.                                                                                                                    |
| `Type: Story`           | The issue is a story under a committed milestone.                                                                                                                  |
| `Story: Exploration`    | The story reduces a consequential uncertainty and applies its conclusions to the milestone and downstream stories.                                                 |
| `Story: Implementation` | The story delivers a coherent vertical product outcome that satisfies its acceptance criteria.                                                                     |
| `Story: Release`        | The story handles an exceptional external transition whose coordination, judgment, or risk requires direct human work. Routine publication is not a release story. |

`Won't Fix` marks a discarded or abandoned issue without replacing its classification labels. GitHub's other stock labels remain available and are used normally alongside these.

## Native GitHub Milestones Are Off Limits

GitHub's native Milestone feature is reserved for **release trains**: it groups milestone issues into the versions they ship in. That is a human release-planning decision, made separately from shaping.

Never create, close, rename, or assign a native GitHub Milestone as part of shaping or persisting a milestone or story. Do it only when explicitly asked.

## Retrieval

Given an issue number, build the full working context before reasoning about the task.

1. Read the issue with its entire comment thread: `gh issue view <n> --comments`.
2. Validate its type-and-kind label pair. If it is a candidate, confirm that it has no sub-issues.
3. If it is a story, read its committed parent milestone the same way, comments included.
4. List the milestone's other stories for sibling context: `gh api repos/YourTechBudStudio/Isagi/issues/<milestone>/sub_issues --jq '.[] | "\(.number) \(.title) [\(.state)]"'`.
5. Follow any `Blocked by`, `Related to`, or `Feeds` references that bear on the task.

The parent of a story is available programmatically as `gh issue view <n> --json parent`.

Comments are not discussion. Every comment on a shaped object is the recorded conclusion of a working session, so the thread is short and each entry is load-bearing. Read all of them. When a comment contains a `## Consolidated State` section, that section supersedes everything above it; earlier content remains readable history but is no longer the current state.

## Bodies

Include only the sections that carry real content. An empty heading is worse than an absent one.

### Candidate Milestone Issue

- **Possible outcome** — the direction that may become valuable.
- **Why it may matter** — the potential value.
- **Why deferred** — why no commitment is being made now.
- **Activation signals** — what should bring it back into shaping, when meaningful.
- **Blocked by** or **Related to** — issue references, only when the relationship is consequential.
- **Context worth preserving** — reasoning that would be expensive to reconstruct.

The first three sections are required. Candidates are unordered, carry no priority, and have no stories, detailed scope, completion condition, or implementation commitment.

### Committed Milestone Issue

- **Goal** — the product outcome being pursued and why it matters.
- **Scope** — what is inside the milestone.
- **Boundaries** — what is deliberately excluded, and why.
- **Completion condition** — what makes this milestone done.
- **Key decisions** — consequential choices, their rationale, and the serious alternatives that were rejected.
- **Open questions** — known unresolved areas and why they matter.
- **Blocked by** or **Related to** — issue references, only when the relationship is consequential.

Both milestone kinds use `[milestone] <product outcome>`. The lowercase prefix is mandatory. Refine the title when understanding changes; record a material rename in an amendment.

### Story Issue

- **Why this exists** — how the story advances its milestone.
- **Product context** — behavior, constraints, or experience that should survive a change of implementation.
- **Acceptance criteria** — observable product or operational conditions with a clear pass or fail judgment, written independently of code structure and implementation sequence.
- **Current thinking** — hypotheses and serious alternatives that seed later brainstorming. Explicitly a starting point, not a commitment.
- **Dependencies** — `Blocked by #12`, when another story genuinely gates useful work here.

An exploration story additionally names:

- **Uncertainty** — what is unknown.
- **Decisions unblocked** — what becomes decidable once it is resolved.
- **Feeds** — the milestone or downstream stories that will consume the conclusions, as issue references.

A story is a vertical slice large enough to warrant its own brainstorming session. It is not a task checklist item.

Title format: `[story] <product outcome>`. The lowercase prefix is mandatory for every story kind.

## Amendments

Shaped objects are append-only once they carry substantive discussion. Do not rewrite an issue body to reflect new understanding; add a comment.

A body may be edited freely while the issue is still fresh and has no substantive comments, which covers fixing a mistake made minutes after publication.

An amendment comment contains:

- **What changed** — the revision, and the reasoning that produced it.
- **`## Consolidated State`** — a complete restatement using the body contract for the object's current kind. This is the replay checkpoint for future readers and supersedes everything above it.

Every kind of revision is an amendment: reshaping a milestone, changing acceptance criteria, splitting or merging shaped objects, recording an exploration's conclusions, or parking work.

### Candidate Activation

Use the candidate as input to fresh shaping. Once hardened, post an amendment with the activation reasoning and consolidated committed state, refine the title if needed, replace `Milestone: Candidate` with `Milestone: Committed`, then create its stories. Never attach a story to a candidate.

### Exploration Reconciliation

An exploration story is not done when its answer is found. It is done when its conclusions have been applied.

Post the conclusions as an amendment comment on the exploration story, then post amendment comments on the parent milestone and on every affected downstream story. Reconciliation may confirm, revise, add, remove, split, or merge stories, or reshape the milestone itself. Close the exploration story only after those amendments exist.

### Parking

A parked story stays open. Record the reason and the return condition as an amendment comment. There is no parked label.

## Lifecycle

- **Open candidate milestone** — uncommitted and available for future shaping.
- **Open committed milestone or story** — active or parked.
- **Closed committed milestone or story** — done and not expected to be revisited.
- **Closed with `Won't Fix`** — discarded or abandoned. Keep the classification labels, record why, add `Won't Fix`, then close.

Candidates close only with `Won't Fix`. To reopen a discarded object, amend it with the reason, remove `Won't Fix`, then reopen it. Removing a shaped object means discarding it, never deleting its history.

## Publication Flow

Preview before publishing. Present a candidate at summary depth. Present a committed milestone and its stories with titles, story kinds, body shapes, and acceptance criteria in substance. Verbatim body text is not required for approval.

Publish a candidate by itself. Publish a committed milestone and its stories in dependency order so parentage can be set at creation time.

1. Create the milestone issue first.
2. Create each story one at a time, attached to the milestone.
3. Report the created issue numbers back.

## Commands

Create a candidate milestone:

```
gh issue create --title "[milestone] <outcome>" --label "Type: Milestone" --label "Milestone: Candidate" --body-file <file>
```

Create a committed milestone:

```
gh issue create --title "[milestone] <outcome>" --label "Type: Milestone" --label "Milestone: Committed" --body-file <file>
```

Create a story under it:

```
gh issue create --title "[story] <outcome>" --label "Type: Story" --label "Story: Implementation" --parent <milestone> --body-file <file>
```

Attach or move an existing story:

```
gh issue edit <story> --parent <milestone>
gh issue edit <milestone> --add-sub-issue <story>
gh issue edit <milestone> --remove-sub-issue <story>
```

Amend:

```
gh issue comment <n> --body-file <file>
```

Activate a candidate after posting its amendment:

```
gh issue edit <candidate> --remove-label "Milestone: Candidate" --add-label "Milestone: Committed"
```

Complete or discard:

```
gh issue close <n>
gh issue edit <n> --add-label "Won't Fix" && gh issue close <n>
```

Survey:

```
gh issue list --label "Type: Milestone" --label "Milestone: Candidate" --state open
gh issue list --label "Type: Milestone" --label "Milestone: Committed" --state all
gh issue list --label "Type: Story" --label "Story: Exploration" --state open
gh api repos/YourTechBudStudio/Isagi/issues/<milestone>/sub_issues
```

Write bodies and comments to a file and pass `--body-file`. Inline `--body` mangles multi-line Markdown.

## Splitting and Merging

Splitting a story creates the new stories under the same milestone, then records the split as an amendment comment on the original. If the original no longer has an outcome of its own, close it with `Won't Fix` and point at the replacements.

Merging closes the absorbed stories with `Won't Fix`, pointing at the survivor, and records the merge as an amendment on the survivor with a consolidated state that covers the combined outcome.

In both cases the milestone gets an amendment when its story set changes materially.

Splitting a candidate creates storyless candidate issues and amends the original. Merging candidates amends the survivor and closes the absorbed candidates with `Won't Fix`. Close a split candidate with `Won't Fix` when it retains no outcome of its own.
