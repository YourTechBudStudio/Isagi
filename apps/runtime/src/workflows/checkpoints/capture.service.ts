/**
 * Checkpoint capture: turning a normalized plan into one immutable checkpoint row, or a named
 * refusal that leaves no row at all.
 *
 * The pipeline, in order, and why each step sits where it does:
 *
 * 1. Load the destination worktree and its project from the database; either missing refuses.
 * 2. Read the Git baseline (HEAD and object format) for a Git project; a folder has none.
 * 3. Load the parent — the run's latest checkpoint — and refuse a scope id rebound to another root
 *    or kind, before a single byte is published.
 * 4. Survey dirty paths (diagnostic) and list the base tree once, literally, under every planned
 *    root and inherited coverage root.
 * 5. Collect every region, then apply the pure region replacement.
 *    5b. When this capture saved files, refuse an inherited file that is the same entry as one of
 *        them under another spelling.
 *    5c. With a commit base, canonicalize base paths into directory-entry spelling (authoritative),
 *        and every survey path diagnostically.
 * 6. Revalidate every directory the capture relied on, and reread HEAD for a Git project.
 * 7. Finish the fold and commit the checkpoint and all its entries in one transaction.
 *
 * Nothing is deleted on a failure path. Bytes published before a refusal or a failed transaction
 * stay in the content store unreferenced; the service logs their references so they can be found.
 */

import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';

import { eq } from 'drizzle-orm';
import { Cause, Context, Effect, Layer } from 'effect';

import type { WorkflowCheckpointBase } from '@isagi/contracts';

import { Git, type GitService } from '../../git/git.command.js';
import {
  type DatabaseError,
  RuntimeDatabase,
  type RuntimeDatabaseService,
} from '../../persistence/index.js';
import { projects, worktrees } from '../../persistence/schema.js';
import {
  makeDirectorySnapshot,
  nodeDirectoryReader,
  resolveWorktreeRoot,
  type DirectoryReader,
  type PathChangedError,
  type PathInspectionError,
} from '../paths.js';
import {
  WorkflowContentStore,
  type WorkflowContentStoreService,
} from '../persistence/content-store.js';
import type { WorkflowCheckpointRecord } from '../persistence/records.js';
import { makeCanonicalizer, type Canonicalizer } from './canonical.js';
import {
  WorkflowCheckpointRepository,
  type WorkflowCheckpointRepositoryService,
} from './checkpoints.repository.js';
import { collectRegions } from './collect.js';
import { CheckpointCaptureFailure } from './failure.js';
import {
  inspectBaseline,
  listBaseLevel,
  listBaseTree,
  readHead,
  surveyDirtyPaths,
  type DirtySurvey,
} from './git-baseline.js';
import { pathContains, type NormalizedCheckpointPlan } from './plan.js';
import {
  applyRegions,
  findScopeIdentityChange,
  finishFold,
  regionContains,
  type ProvisionalState,
} from './resolve.js';
import type { BaseTreeEntry, CanonicalBaseEntry, CanonicalDirtyEntry } from './types.js';

export { CheckpointCaptureFailure, type CheckpointCaptureFailureReason } from './failure.js';

/** Who the checkpoint belongs to, and what it saves. */
export interface CaptureCheckpointInput {
  readonly runId: number;
  readonly frameId: number;
  readonly executionId: number;
  readonly attemptId: number;
  readonly artifactHash: string;
  readonly nodeId: string;
  /** The run's destination worktree; null means the run has no destination to capture. */
  readonly worktreeId: number | null;
  readonly plan: NormalizedCheckpointPlan;
}

export interface WorkflowCheckpointCaptureService {
  readonly capture: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<WorkflowCheckpointRecord, CheckpointCaptureFailure | DatabaseError>;
}

export const WorkflowCheckpointCapture = Context.GenericTag<WorkflowCheckpointCaptureService>(
  'isagi/WorkflowCheckpointCapture',
);

export interface WorkflowCheckpointCaptureDependencies {
  readonly git: GitService;
  readonly content: WorkflowContentStoreService;
  readonly checkpoints: WorkflowCheckpointRepositoryService;
  readonly database: Pick<RuntimeDatabaseService, 'use'>;
  readonly now?: () => string;
  /** Defaults to the real filesystem; tests inject aliasing or mutating readers. */
  readonly directoryReader?: DirectoryReader;
}

interface Destination {
  readonly worktreePath: string;
  readonly projectId: number;
  readonly projectRootPath: string;
  readonly projectKind: 'git' | 'folder';
}

export function makeWorkflowCheckpointCapture(
  deps: WorkflowCheckpointCaptureDependencies,
): WorkflowCheckpointCaptureService {
  const now = deps.now ?? (() => new Date().toISOString());
  const reader = deps.directoryReader ?? nodeDirectoryReader;

  const loadDestination = (worktreeId: number | null) =>
    Effect.gen(function* () {
      const row =
        worktreeId === null
          ? undefined
          : yield* deps.database.use('workflow_checkpoint_destination', (db) =>
              db
                .select({
                  worktreePath: worktrees.path,
                  projectId: projects.id,
                  projectRootPath: projects.rootPath,
                  projectKind: projects.kind,
                })
                .from(worktrees)
                .innerJoin(projects, eq(projects.id, worktrees.projectId))
                .where(eq(worktrees.id, worktreeId))
                .get(),
            );
      if (!row) {
        return yield* new CheckpointCaptureFailure({
          reason: 'destination_unavailable',
          message: 'The run’s destination worktree or its project no longer exists.',
        });
      }
      return row satisfies Destination;
    });

  const capture = (input: CaptureCheckpointInput, published: string[]) =>
    Effect.gen(function* () {
      // Step 1. Minted now so the fold can attribute coverage and warnings before a row exists.
      const checkpointKey = `wcp_${randomUUID()}`;
      const destination = yield* loadDestination(input.worktreeId);
      const root = yield* resolveWorktreeRoot(reader, destination.worktreePath).pipe(
        Effect.mapError((error) => {
          const code = (error.cause as { code?: unknown } | null)?.code;
          return code === 'ENOENT' || code === 'ENOTDIR'
            ? new CheckpointCaptureFailure({
                reason: 'destination_unavailable',
                message: `The destination worktree ${destination.worktreePath} no longer exists.`,
                cause: error.cause,
              })
            : new CheckpointCaptureFailure({
                reason: 'path_inspection_failed',
                message: `Could not inspect the destination worktree ${destination.worktreePath}.`,
                cause: error.cause,
              });
        }),
      );
      const git = deps.git;
      const snapshot = makeDirectorySnapshot(reader);
      const canonical = makeCanonicalizer(snapshot, root);
      const toRelative = (absolute: string) => relative(root, absolute) || '.';

      // Step 2.
      const isGitProject = destination.projectKind === 'git';
      const baseline = isGitProject ? yield* inspectBaseline(git, root) : null;
      const head = baseline?.head ?? null;
      const base: WorkflowCheckpointBase = !isGitProject
        ? { kind: 'none', reason: 'folder_project' }
        : head === null
          ? { kind: 'none', reason: 'unborn_repository' }
          : { kind: 'git', repositoryId: destination.projectId, commitSha: head };

      // Step 3.
      const parent = yield* deps.checkpoints.findLatestInRun(input.runId);
      const parentState = parent ? yield* deps.checkpoints.resolvedStateOf(parent.id) : null;
      if (parentState) {
        const changed = findScopeIdentityChange(parentState.bindings, input.plan.scopes);
        if (changed) {
          return yield* new CheckpointCaptureFailure({
            reason: 'scope_identity_changed',
            message: `Scope ${changed.scope.scopeId} was bound to the ${changed.previous.kind} ${changed.previous.path} and cannot be rebound to the ${changed.scope.kind} ${changed.scope.path}; use a new scope id.`,
            path: changed.scope.path,
            scopeId: changed.scope.scopeId,
          });
        }
      }

      // Step 4. Coverage after the fold is always a subset of these roots, so one literal listing
      // serves both the empty-recapture rule and the absences.
      const survey: DirtySurvey | null = isGitProject
        ? yield* surveyDirtyPaths(git, root, input.plan.scopes)
        : null;
      const planRoots = input.plan.scopes.map((scope) => scope.path);
      const listedRoots = [
        ...new Set([...planRoots, ...(parentState?.coverage ?? []).map((region) => region.path)]),
      ];
      const listing = head === null ? [] : yield* listBaseTree(git, root, head, listedRoots);
      const baseTrackedRoots = new Set(
        planRoots.filter((path) => listing.some((entry) => pathContains(path, entry.path))),
      );

      // Step 5.
      const regions = yield* collectRegions({
        root,
        scopes: input.plan.scopes,
        parentCoverage: parentState?.coverage ?? [],
        baseTrackedRoots,
        objectFormat: baseline?.objectFormat ?? null,
        content: deps.content,
        snapshot,
        onPublished: (contentRef) => published.push(contentRef),
      });
      const provisional = applyRegions({ checkpointKey, parent: parentState, regions });

      // Step 5b. With nothing collected, no inherited path can alias a newly saved file.
      if (provisional.collected.size > 0) {
        yield* refuseInheritedAliases(canonical, provisional, toRelative);
      }

      // Step 5c.
      const baseEntries =
        head === null
          ? []
          : yield* canonicalizeBase({
              git,
              root,
              head,
              canonical,
              provisional,
              listing,
              toRelative,
            });
      const canonicalSurvey = survey === null ? null : yield* canonicalizeSurvey(canonical, survey);

      // Step 6. Closes the bracket collection opened: every directory the capture relied on.
      const moved = yield* snapshot.revalidate().pipe(
        Effect.mapError(
          (error) =>
            new CheckpointCaptureFailure({
              reason: 'path_inspection_failed',
              message: `Could not re-inspect ${toRelative(error.path)} to confirm the capture was stable.`,
              path: toRelative(error.path),
              cause: error.cause,
            }),
        ),
      );
      if (moved) {
        return yield* new CheckpointCaptureFailure({
          reason: 'unstable_capture',
          message: `${toRelative(moved.changed)} changed while the checkpoint was being captured.`,
          path: toRelative(moved.changed),
        });
      }
      if (isGitProject) {
        const headAgain = yield* readHead(git, root);
        if (headAgain !== head) {
          return yield* new CheckpointCaptureFailure({
            reason: 'head_changed',
            message: `HEAD moved from ${head ?? 'no commit'} to ${headAgain ?? 'no commit'} while the checkpoint was being captured.`,
          });
        }
      }

      // Step 7.
      const folded = finishFold({
        checkpointKey,
        provisional,
        base: baseEntries,
        survey: canonicalSurvey,
        isGitProject,
      });
      const conflict = folded.kindConflicts[0];
      if (conflict) {
        return yield* new CheckpointCaptureFailure({
          reason: 'path_kind_conflict',
          message: `The saved state would need ${conflict[0]} to be a file while ${conflict[1]} lies beneath it.`,
          path: conflict[0],
        });
      }
      return yield* deps.checkpoints.commitCapture({
        runId: input.runId,
        frameId: input.frameId,
        executionId: input.executionId,
        attemptId: input.attemptId,
        artifactHash: input.artifactHash,
        nodeId: input.nodeId,
        checkpointKey,
        parentCheckpointId: parent?.id ?? null,
        title: input.plan.title,
        base,
        repositoryProjectId: destination.projectId,
        repositoryRootPath: destination.projectRootPath,
        entries: folded.entries,
        counts: folded.counts,
        now: now(),
      });
    });

  return {
    capture: (input) => {
      const published: string[] = [];
      return capture(input, published).pipe(
        // The only trace of bytes whose checkpoint never became durable: nothing references them
        // and there is no sweeper. Contents never appear here, only their references.
        Effect.onError((cause) =>
          published.length === 0
            ? Effect.void
            : Effect.sync(() => {
                const failure = Cause.failureOption(cause);
                const outcome =
                  failure._tag === 'None'
                    ? { fault: Cause.isInterruptedOnly(cause) ? 'interrupted' : 'defect' }
                    : failure.value._tag === 'CheckpointCaptureFailure'
                      ? { reason: failure.value.reason }
                      : { fault: failure.value._tag, operation: failure.value.operation };
                console.warn(
                  '[runtime] Workflow checkpoint capture committed no checkpoint for published content',
                  {
                    runId: input.runId,
                    executionId: input.executionId,
                    ...outcome,
                    contentRefs: [...new Set(published)],
                  },
                );
              }),
        ),
      );
    },
  };
}

function fromReadError(
  error: PathInspectionError | PathChangedError,
  toRelative: (absolute: string) => string,
): CheckpointCaptureFailure {
  const path = toRelative(error.path);
  return error._tag === 'PathChangedError'
    ? new CheckpointCaptureFailure({
        reason: 'unstable_capture',
        message: `${path} changed while the checkpoint was being captured.`,
        path,
      })
    : new CheckpointCaptureFailure({
        reason: 'path_inspection_failed',
        message: `Could not inspect ${path}.`,
        path,
        cause: error.cause,
      });
}

function collision(path: string, others: readonly string[]): CheckpointCaptureFailure {
  return new CheckpointCaptureFailure({
    reason: 'path_identity_collision',
    message: `${path} and ${others.join(', ')} name the same file on this filesystem; rename one so they agree, or capture a directory that contains both.`,
    path,
  });
}

/**
 * Step 5b. An inherited file outside this capture's regions that the filesystem resolves to a file
 * this capture just saved would put two spellings of one entry in the inventory, and export would
 * depend on the order it wrote them. Anything else stays inherited.
 */
function refuseInheritedAliases(
  canonical: Canonicalizer,
  provisional: ProvisionalState,
  toRelative: (absolute: string) => string,
) {
  return Effect.gen(function* () {
    for (const path of provisional.files.keys()) {
      if (provisional.collected.has(path)) continue;
      const resolved = yield* canonical
        .canonicalize(path, 'authoritative')
        .pipe(Effect.mapError((error) => fromReadError(error, toRelative)));
      if (resolved.kind === 'ambiguous') {
        const hit = resolved.candidates.filter((candidate) =>
          [...provisional.collected.keys()].some((saved) => pathContains(candidate, saved)),
        );
        if (hit.length > 0) return yield* collision(path, hit);
        continue;
      }
      if (resolved.authored !== path && provisional.collected.has(resolved.authored)) {
        return yield* collision(path, [resolved.authored]);
      }
    }
  });
}

/**
 * Step 5c, passes (a) and (b): the base entries relevant to final coverage, in both spellings.
 *
 * (a) For each coverage root that exists on disk, find base spellings that alias it (`Apps` in the
 * commit, `apps` on disk) level by level, and list the base tree under those too. An absent root is
 * listed under its own spelling only: two names that do not both exist are never related.
 * (b) Canonicalize every candidate entry; a respelled entry may only ever become an absence, so one
 * that lands on a resolved file is refused.
 */
function canonicalizeBase(input: {
  readonly git: GitService;
  readonly root: string;
  readonly head: string;
  readonly canonical: Canonicalizer;
  readonly provisional: ProvisionalState;
  readonly listing: readonly BaseTreeEntry[];
  readonly toRelative: (absolute: string) => string;
}): Effect.Effect<readonly CanonicalBaseEntry[], CheckpointCaptureFailure> {
  const { git, root, head, canonical, provisional, toRelative } = input;
  const levels = new Map<string, readonly string[]>();
  const levelOf = (parent: string) =>
    Effect.gen(function* () {
      const known = levels.get(parent);
      if (known) return known;
      const names = yield* listBaseLevel(git, root, head, parent);
      levels.set(parent, names);
      return names;
    });
  const read = <A>(effect: Effect.Effect<A, PathInspectionError | PathChangedError>) =>
    effect.pipe(Effect.mapError((error) => fromReadError(error, toRelative)));

  return Effect.gen(function* () {
    const coverageRoots = [...new Set(provisional.coverage.map((region) => region.path))];
    const aliasRoots: string[] = [];
    for (const coverageRoot of coverageRoots) {
      aliasRoots.push(...(yield* baseSpellingsOf(coverageRoot)));
    }
    const extra = yield* listBaseTree(git, root, head, aliasRoots);

    const byOriginal = new Map<string, BaseTreeEntry>();
    for (const entry of [...input.listing, ...extra]) byOriginal.set(entry.path, entry);
    const listedUnder = [...coverageRoots, ...aliasRoots];

    const entries: CanonicalBaseEntry[] = [];
    for (const entry of byOriginal.values()) {
      if (!listedUnder.some((listedRoot) => pathContains(listedRoot, entry.path))) continue;
      const resolved = yield* read(canonical.canonicalize(entry.path, 'authoritative'));
      if (resolved.kind === 'ambiguous') return yield* collision(entry.path, resolved.candidates);
      const authored = resolved.authored;
      if (!provisional.coverage.some((region) => regionContains(region, authored))) continue;
      if (authored !== entry.path && provisional.files.has(authored)) {
        return yield* collision(entry.path, [authored]);
      }
      entries.push({
        original: entry.path,
        authored,
        objectId: entry.objectId,
        executable: entry.executable,
      });
    }
    return entries;
  });

  function baseSpellingsOf(coverageRoot: string) {
    return Effect.gen(function* () {
      const names = coverageRoot.split('/');
      // The root must exist verbatim for any other spelling to be provably its alias.
      let authored = '';
      for (const name of names) {
        const spelling = yield* read(canonical.component(authored, name, 'authoritative'));
        if (spelling.kind !== 'verbatim') return [];
        authored = authored === '' ? name : `${authored}/${name}`;
      }
      let prefixes = [''];
      authored = '';
      for (const name of names) {
        const next: string[] = [];
        for (const prefix of prefixes) {
          for (const candidate of yield* levelOf(prefix)) {
            const spelled = prefix === '' ? candidate : `${prefix}/${candidate}`;
            if (candidate === name) {
              next.push(spelled);
              continue;
            }
            const spelling = yield* read(canonical.component(authored, candidate, 'authoritative'));
            if (spelling.kind === 'respelled' && spelling.name === name) next.push(spelled);
            if (spelling.kind === 'ambiguous') {
              return yield* collision(spelled, spelling.candidates);
            }
          }
        }
        prefixes = next;
        authored = authored === '' ? name : `${authored}/${name}`;
      }
      return prefixes.filter((prefix) => prefix !== coverageRoot);
    });
  }
}

/**
 * Step 5c, pass (c): survey paths into directory-entry spelling, diagnostically. The survey informs
 * warnings only, so a read that fails or a directory that moves leaves the entry in Git's spelling,
 * to be reported as uncaptured, and never fails the capture. A collapsed directory's trailing `/` is
 * dropped for matching and kept in the warning.
 */
function canonicalizeSurvey(canonical: Canonicalizer, survey: DirtySurvey) {
  return Effect.gen(function* () {
    if (!survey.ok) return { ok: false } as const;
    const entries: CanonicalDirtyEntry[] = [];
    for (const entry of survey.entries) {
      const stripped = entry.collapsedDirectory ? entry.path.slice(0, -1) : entry.path;
      const resolved = yield* canonical.canonicalize(stripped, 'diagnostic').pipe(
        Effect.map((result) => (result.kind === 'resolved' ? result.authored : stripped)),
        Effect.orElseSucceed(() => stripped),
      );
      entries.push({
        original: entry.path,
        authored: resolved,
        collapsedDirectory: entry.collapsedDirectory,
      });
    }
    return { ok: true, entries } as const;
  });
}

export const WorkflowCheckpointCaptureLive = Layer.effect(
  WorkflowCheckpointCapture,
  Effect.gen(function* () {
    return makeWorkflowCheckpointCapture({
      git: yield* Git,
      content: yield* WorkflowContentStore,
      checkpoints: yield* WorkflowCheckpointRepository,
      database: yield* RuntimeDatabase,
    });
  }),
);
