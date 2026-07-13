import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import { Data, Effect } from 'effect';

import type { AgentHarness, DocsReconciliationResult } from '@isagi/contracts';

import { harnessDefinition, supportedHarnesses } from '../agent-sessions/harness/definitions.js';
import { isagiDocsPackageFiles } from '../agent-sessions/harness/isagi-docs.js';
import { executableAvailability, type HostInventory } from '../host-inventory/types.js';
import { boundedDiagnostic } from '../lib/diagnostic.js';
import type { RuntimeHarnessPolicy } from '../runtime-config/index.js';

export interface DocsReconciliationInput {
  readonly dataRoot: string;
  readonly policy: RuntimeHarnessPolicy;
  readonly policyRevision: string;
  readonly inventoryGeneration: number;
  readonly inventory: HostInventory;
}

type HarnessResult = DocsReconciliationResult['results'][number];

export interface PublicationFileSystem {
  readonly exists: (path: string) => boolean;
  readonly copy: (source: string, destination: string) => void;
  readonly mkdir: (path: string) => void;
  readonly readdir: (path: string) => readonly string[];
  readonly rename: (source: string, destination: string) => void;
  readonly remove: (path: string) => void;
  readonly write: (path: string, content: string, exclusive?: boolean) => void;
}

const nodeFileSystem: PublicationFileSystem = {
  exists: existsSync,
  copy: (source, destination) =>
    cpSync(source, destination, { recursive: true, errorOnExist: true }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  readdir: readdirSync,
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  write: (path, content, exclusive = false) =>
    writeFileSync(path, content, { encoding: 'utf8', ...(exclusive ? { flag: 'wx' } : {}) }),
};

export class DocsPublicationFailure extends Data.TaggedError('DocsPublicationFailure')<{
  readonly reason: 'transaction_evidence' | 'publication_failed' | 'rollback_failed';
  readonly diagnostic: string;
}> {}

export function docsReconciliationFingerprint(input: DocsReconciliationInput) {
  if (input.inventory.environment._tag === 'ProbeFailed')
    return createHash('sha256')
      .update(JSON.stringify({ policy: input.policy, environment: 'failed' }))
      .digest('hex');
  const canonical = isagiDocsPackageFiles(input.dataRoot);
  const projection = supportedHarnesses.map((harness) => ({
    harness,
    intent: input.policy[harness],
    nativePolicy: harnessDefinition(harness).docs.nativePolicy,
    target: harnessDefinition(harness).docs.resolveTarget(input.inventory.environment.values),
    legacyTargets: harnessDefinition(harness).docs.resolveLegacyTargets(
      input.inventory.environment.values,
    ),
    files: [
      ...harnessDefinition(harness).docs.project({
        dataRoot: input.dataRoot,
        canonicalFiles: canonical,
      }),
    ],
  }));
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

export function reconcileDocs(
  input: DocsReconciliationInput,
): Effect.Effect<DocsReconciliationResult> {
  const fingerprint = docsReconciliationFingerprint(input);
  const canonical = isagiDocsPackageFiles(input.dataRoot);
  return Effect.forEach(
    supportedHarnesses,
    (harness) => reconcileHarness(input, harness, canonical),
    { concurrency: 1 },
  ).pipe(
    Effect.map((results) => ({
      outcome: aggregateOutcome(results),
      policyRevision: input.policyRevision,
      inventoryGeneration: input.inventoryGeneration,
      fingerprint,
      results,
    })),
  );
}

function reconcileHarness(
  input: DocsReconciliationInput,
  harness: AgentHarness,
  canonical: ReadonlyMap<string, string>,
): Effect.Effect<HarnessResult> {
  const availability = executableAvailability(input.inventory.harnesses[harness]);
  const intent = input.policy[harness];
  if (!intent.enabled || !intent.installIsagiDocs)
    return Effect.succeed({
      harness,
      availability,
      action: 'untouched',
      reason: 'not_requested',
      destination: null,
      diagnostic: null,
    });
  if (input.inventory.environment._tag === 'ProbeFailed')
    return Effect.succeed({
      harness,
      availability,
      action: 'failed',
      reason: 'environment_capture_failed',
      destination: null,
      diagnostic: boundedDiagnostic(input.inventory.environment.diagnostic),
    });
  const docs = harnessDefinition(harness).docs;
  if (!docs.explicitInvocationSupported)
    return Effect.succeed({
      harness,
      availability,
      action: 'unsupported',
      reason: 'explicit_invocation_unsupported',
      destination: null,
      diagnostic: 'This harness cannot guarantee explicit-only invocation.',
    });
  const target = docs.resolveTarget(input.inventory.environment.values);
  if (target._tag !== 'Resolved')
    return Effect.succeed({
      harness,
      availability,
      action: 'failed',
      reason: 'target_resolution_failed',
      destination: null,
      diagnostic: `${target.required} is unavailable.`,
    });
  const legacyTargets = docs.resolveLegacyTargets(input.inventory.environment.values);
  const unresolvedLegacyTarget = legacyTargets.find((legacy) => legacy._tag !== 'Resolved');
  if (unresolvedLegacyTarget?._tag === 'MissingEnvironmentRoot')
    return Effect.succeed({
      harness,
      availability,
      action: 'failed',
      reason: 'target_resolution_failed',
      destination: target.path,
      diagnostic: `${unresolvedLegacyTarget.required} is unavailable.`,
    });
  const resolvedLegacyTargets = legacyTargets.flatMap((legacy) =>
    legacy._tag === 'Resolved' ? [legacy.path] : [],
  );
  const existed = nodeFileSystem.exists(target.path);
  return publishDocsTargets({
    destination: target.path,
    legacyDestinations: resolvedLegacyTargets,
    files: docs.project({ dataRoot: input.dataRoot, canonicalFiles: canonical }),
  }).pipe(
    Effect.as({
      harness,
      availability,
      action: existed ? 'replaced' : 'installed',
      reason: null,
      destination: target.path,
      diagnostic: null,
    } satisfies HarnessResult),
    Effect.catchAll((error) =>
      Effect.succeed({
        harness,
        availability,
        action: 'failed',
        reason: error.reason,
        destination: target.path,
        diagnostic: error.diagnostic,
      } satisfies HarnessResult),
    ),
  );
}

export function publishDocsTargets(
  input: {
    readonly destination: string;
    readonly legacyDestinations: readonly string[];
    readonly files: ReadonlyMap<string, string>;
  },
  fileSystem: PublicationFileSystem = nodeFileSystem,
): Effect.Effect<void, DocsPublicationFailure> {
  return Effect.uninterruptible(
    Effect.try({
      try: () => publishTransaction(input, fileSystem),
      catch: (cause) =>
        cause instanceof DocsPublicationFailure
          ? cause
          : new DocsPublicationFailure({
              reason: 'publication_failed',
              diagnostic: boundedDiagnostic(cause),
            }),
    }),
  );
}

function publishTransaction(
  input: {
    readonly destination: string;
    readonly legacyDestinations: readonly string[];
    readonly files: ReadonlyMap<string, string>;
  },
  fileSystem: PublicationFileSystem,
) {
  const token = randomUUID();
  const destinationParent = dirname(input.destination);
  const legacyDestinations = [
    ...new Set(input.legacyDestinations.filter((destination) => destination !== input.destination)),
  ];
  const transactionParents = [...new Set([destinationParent, ...legacyDestinations.map(dirname)])];
  fileSystem.mkdir(destinationParent);
  for (const parent of transactionParents) {
    if (!fileSystem.exists(parent)) continue;
    if (
      fileSystem
        .readdir(parent)
        .some(
          (name) => name.startsWith('.isagi-docs-stage-') || name.startsWith('.isagi-docs-backup-'),
        )
    )
      throw new DocsPublicationFailure({
        reason: 'transaction_evidence',
        diagnostic: 'Existing Isagi Docs transaction evidence requires manual recovery.',
      });
  }

  const stage = resolve(destinationParent, `.isagi-docs-stage-${token}`);
  const currentBackup = resolve(destinationParent, `.isagi-docs-backup-${token}-current`);
  const rollbackBundle = resolve(destinationParent, `.isagi-docs-backup-${token}-rollback`);
  const currentRecovery = resolve(rollbackBundle, 'current');
  const legacyBackups = legacyDestinations.map((destination, index) => ({
    destination,
    backup: resolve(dirname(destination), `.isagi-docs-backup-${token}-legacy-${index}`),
    recovery: resolve(rollbackBundle, `legacy-${index}`),
    moved: false,
  }));
  let currentMoved = false;
  let published = false;
  try {
    writeStage(stage, input.files, fileSystem);
    if (fileSystem.exists(input.destination)) {
      fileSystem.rename(input.destination, currentBackup);
      currentMoved = true;
    }
    for (const legacy of legacyBackups) {
      if (!fileSystem.exists(legacy.destination)) continue;
      fileSystem.rename(legacy.destination, legacy.backup);
      legacy.moved = true;
    }
    fileSystem.rename(stage, input.destination);
    published = true;
    if (currentMoved || legacyBackups.some((legacy) => legacy.moved)) {
      fileSystem.mkdir(rollbackBundle);
      if (currentMoved) fileSystem.copy(currentBackup, currentRecovery);
      for (const legacy of legacyBackups) {
        if (legacy.moved) fileSystem.copy(legacy.backup, legacy.recovery);
      }
      for (const legacy of legacyBackups) {
        if (legacy.moved) fileSystem.remove(legacy.backup);
      }
      if (currentMoved) fileSystem.remove(currentBackup);
      fileSystem.remove(rollbackBundle);
    }
  } catch (publicationError) {
    try {
      rollbackPublication({
        destination: input.destination,
        currentBackup,
        currentRecovery,
        currentMoved,
        published,
        legacyBackups,
        rollbackBundle,
        fileSystem,
      });
    } catch (rollbackError) {
      throw new DocsPublicationFailure({
        reason: 'rollback_failed',
        diagnostic: boundedDiagnostic(
          `${String(publicationError)}; rollback: ${String(rollbackError)}`,
        ),
      });
    }
    throw publicationError;
  } finally {
    if (fileSystem.exists(stage)) fileSystem.remove(stage);
  }
}

function rollbackPublication(input: {
  readonly destination: string;
  readonly currentBackup: string;
  readonly currentRecovery: string;
  readonly currentMoved: boolean;
  readonly published: boolean;
  readonly legacyBackups: readonly {
    readonly destination: string;
    readonly backup: string;
    readonly recovery: string;
    readonly moved: boolean;
  }[];
  readonly rollbackBundle: string;
  readonly fileSystem: PublicationFileSystem;
}) {
  if (input.published && input.fileSystem.exists(input.destination)) {
    input.fileSystem.remove(input.destination);
  }
  if (input.currentMoved && input.fileSystem.exists(input.currentBackup)) {
    input.fileSystem.rename(input.currentBackup, input.destination);
  } else if (input.currentMoved && input.fileSystem.exists(input.currentRecovery)) {
    input.fileSystem.copy(input.currentRecovery, input.destination);
  } else if (input.currentMoved) {
    throw new Error(`Cannot restore the previous Isagi Docs destination.`);
  }
  for (const legacy of input.legacyBackups) {
    if (legacy.moved && input.fileSystem.exists(legacy.backup)) {
      input.fileSystem.rename(legacy.backup, legacy.destination);
    } else if (legacy.moved && input.fileSystem.exists(legacy.recovery)) {
      input.fileSystem.copy(legacy.recovery, legacy.destination);
    } else if (legacy.moved) {
      throw new Error(`Cannot restore a previous Isagi Docs legacy destination.`);
    }
  }
  if (input.fileSystem.exists(input.rollbackBundle)) input.fileSystem.remove(input.rollbackBundle);
}

function writeStage(
  stage: string,
  files: ReadonlyMap<string, string>,
  fileSystem: PublicationFileSystem,
) {
  if (files.size === 1 && files.has('')) {
    fileSystem.write(stage, files.get('')!, true);
    return;
  }
  for (const [path, content] of files) {
    const target = resolve(stage, path);
    fileSystem.mkdir(dirname(target));
    fileSystem.write(target, content, true);
  }
}

function aggregateOutcome(results: readonly HarnessResult[]) {
  const requested = results.filter((result) => result.reason !== 'not_requested');
  const failed = requested.filter(
    (result) => result.action === 'failed' || result.action === 'unsupported',
  ).length;
  return failed === 0 ? 'succeeded' : failed === requested.length ? 'failed' : 'partially_failed';
}
