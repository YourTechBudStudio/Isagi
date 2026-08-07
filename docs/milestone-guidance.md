# Milestone Guidance

This document defines how Isagi's milestones and stories are represented, retrieved, and amended. It is the repository-specific persistence contract used by the `shaping-milestones` skill.

Milestones and stories live in GitHub Issues on `YourTechBudStudio/Isagi`. They are not stored in this repository. This document is the mapping; GitHub is the source of truth.

Read this document before retrieving, creating, or amending any milestone or story. When a task begins with an issue number, follow [Retrieval](#retrieval) before doing anything else.

## Object Model

| Concept                        | GitHub representation                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Milestone                      | An issue labeled `type:milestone`                                                                                          |
| Story                          | An issue labeled with exactly one `story:*` label, attached as a **sub-issue** of its milestone issue                      |
| Story kind                     | `story:exploration`, `story:implementation`, or `story:release`                                                            |
| Milestone ↔ story navigation   | GitHub's native sub-issue relationship                                                                                     |
| Dependency between stories     | A plain issue reference in the body (`Blocked by #12`)                                                                     |
| Exploration consumer           | A plain issue reference in the body (`Feeds #14, #15`)                                                                     |
| Amendment to any shaped object | A new comment on that issue, never an edit                                                                                 |
| Spark                          | Not configured. Sparks arrive from an external system that has not been chosen yet. Do not create GitHub objects for them. |

An issue carrying neither `type:milestone` nor a `story:*` label is not a shaped object. On a public repository that is usually community input, and it is outside this system.

## Labels

These four labels are owned by this system.

| Label                  | Meaning                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type:milestone`       | The issue is a milestone. It has stories as sub-issues.                                                                                                            |
| `story:exploration`    | The story reduces a consequential uncertainty and applies its conclusions to the milestone and downstream stories.                                                 |
| `story:implementation` | The story delivers a coherent vertical product outcome that satisfies its acceptance criteria.                                                                     |
| `story:release`        | The story handles an exceptional external transition whose coordination, judgment, or risk requires direct human work. Routine publication is not a release story. |

GitHub's stock labels (`bug`, `enhancement`, `documentation`, `wontfix`, and the rest) remain available and are used normally alongside these.

## Native GitHub Milestones Are Off Limits

GitHub's native Milestone feature is reserved for **release trains**: it groups milestone issues into the versions they ship in. That is a human release-planning decision, made separately from shaping.

Never create, close, rename, or assign a native GitHub Milestone as part of shaping or persisting a milestone or story. Do it only when explicitly asked.

## Retrieval

Given an issue number, build the full working context before reasoning about the task.

1. Read the issue with its entire comment thread: `gh issue view <n> --comments`.
2. If it is a story, read its parent milestone the same way, comments included.
3. List the milestone's other stories for sibling context: `gh api repos/YourTechBudStudio/Isagi/issues/<milestone>/sub_issues --jq '.[] | "\(.number) \(.title) [\(.state)]"'`.
4. Follow any `Blocked by` or `Feeds` references that bear on the task.

The parent of a story is available programmatically as `gh issue view <n> --json parent`.

Comments are not discussion. Every comment on a shaped object is the recorded conclusion of a working session, so the thread is short and each entry is load-bearing. Read all of them. When a comment contains a `## Consolidated State` section, that section supersedes everything above it; earlier content remains readable history but is no longer the current state.

## Bodies

Include only the sections that carry real content. An empty heading is worse than an absent one.

### Milestone Issue

- **Goal** — the product outcome being pursued and why it matters.
- **Scope** — what is inside the milestone.
- **Boundaries** — what is deliberately excluded, and why.
- **Completion condition** — what makes this milestone done.
- **Key decisions** — consequential choices, their rationale, and the serious alternatives that were rejected.
- **Open questions** — known unresolved areas and why they matter.

Title format: `Milestone: <product outcome>`.

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

## Amendments

Shaped objects are append-only once they carry substantive discussion. Do not rewrite an issue body to reflect new understanding; add a comment.

A body may be edited freely while the issue is still fresh and has no substantive comments, which covers fixing a mistake made minutes after publication.

An amendment comment contains:

- **What changed** — the revision, and the reasoning that produced it.
- **`## Consolidated State`** — a restatement of the object's current goal, scope, and acceptance criteria as of this comment. This is the replay checkpoint for future readers and supersedes everything above it.

Every kind of revision is an amendment: reshaping a milestone, changing acceptance criteria, splitting or merging stories, recording an exploration's conclusions, or parking work.

### Exploration Reconciliation

An exploration story is not done when its answer is found. It is done when its conclusions have been applied.

Post the conclusions as an amendment comment on the exploration story, then post amendment comments on the parent milestone and on every affected downstream story. Reconciliation may confirm, revise, add, remove, split, or merge stories, or reshape the milestone itself. Close the exploration story only after those amendments exist.

### Parking

A parked story stays open. Record the reason and the return condition as an amendment comment. There is no parked label.

## Lifecycle

- **Open** — active or parked.
- **Closed** — done, and not expected to be revisited.
- **Closed with `wontfix`** — discarded. Apply the label, record why in a comment, then close.

## Publication Flow

Preview before publishing. Present the intended milestone and its stories in the working conversation at summary depth: titles, story kinds, the shape of each body, and the acceptance criteria in substance. Verbatim body text is not required for approval.

After approval, publish in dependency order so parentage can be set at creation time.

1. Create the milestone issue first.
2. Create each story one at a time, attached to the milestone.
3. Report the created issue numbers back.

## Commands

Create a milestone:

```
gh issue create --title "Milestone: <outcome>" --label type:milestone --body-file <file>
```

Create a story under it:

```
gh issue create --title "<outcome>" --label story:implementation --parent <milestone> --body-file <file>
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

Complete or discard:

```
gh issue close <n>
gh issue edit <n> --add-label wontfix && gh issue close <n>
```

Survey:

```
gh issue list --label type:milestone --state all
gh issue list --label story:exploration --state open
gh api repos/YourTechBudStudio/Isagi/issues/<milestone>/sub_issues
```

Write bodies and comments to a file and pass `--body-file`. Inline `--body` mangles multi-line Markdown.

## Splitting and Merging

Splitting a story creates the new stories under the same milestone, then records the split as an amendment comment on the original. If the original no longer has an outcome of its own, close it with `wontfix` and point at the replacements.

Merging closes the absorbed stories with `wontfix`, pointing at the survivor, and records the merge as an amendment on the survivor with a consolidated state that covers the combined outcome.

In both cases the milestone gets an amendment when its story set changes materially.
