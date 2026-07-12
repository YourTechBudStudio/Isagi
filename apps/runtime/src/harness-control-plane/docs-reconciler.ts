import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  readonly mkdir: (path: string) => void;
  readonly readdir: (path: string) => readonly string[];
  readonly rename: (source: string, destination: string) => void;
  readonly remove: (path: string) => void;
  readonly write: (path: string, content: string, exclusive?: boolean) => void;
}

const nodeFileSystem: PublicationFileSystem = {
  exists: existsSync,
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
    target: harnessDefinition(harness).docs.resolveTarget(input.inventory.environment.values),
    files: [...renderForHarness(harness, input.dataRoot, canonical)],
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
  const existed = nodeFileSystem.exists(target.path);
  return publishDocsTarget(target.path, renderForHarness(harness, input.dataRoot, canonical)).pipe(
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

export function renderForHarness(
  harness: AgentHarness,
  dataRoot: string,
  files: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  if (harness === 'opencode')
    return new Map([
      [
        '',
        `# Isagi Docs\n\nRead ${resolve(dataRoot, 'skills', 'shared', 'isagi-docs', 'SKILL.md')} and follow its references for the user's request.\n`,
      ],
    ]);
  const rendered = new Map(files);
  if (harness === 'codex')
    rendered.set('agents/openai.yaml', 'policy:\n  allow_implicit_invocation: false\n');
  return rendered;
}

export function publishDocsTarget(
  destination: string,
  files: ReadonlyMap<string, string>,
  fileSystem: PublicationFileSystem = nodeFileSystem,
): Effect.Effect<void, DocsPublicationFailure> {
  return Effect.uninterruptible(
    Effect.try({
      try: () => publishTransaction(destination, files, fileSystem),
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
  destination: string,
  files: ReadonlyMap<string, string>,
  fileSystem: PublicationFileSystem,
) {
  const parent = dirname(destination);
  fileSystem.mkdir(parent);
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
  const token = randomUUID();
  const stage = resolve(parent, `.isagi-docs-stage-${token}`);
  const backup = resolve(parent, `.isagi-docs-backup-${token}`);
  try {
    writeStage(stage, files, fileSystem);
    if (fileSystem.exists(destination)) fileSystem.rename(destination, backup);
    try {
      fileSystem.rename(stage, destination);
    } catch (publicationError) {
      try {
        if (fileSystem.exists(backup)) fileSystem.rename(backup, destination);
      } catch (rollbackError) {
        throw new DocsPublicationFailure({
          reason: 'rollback_failed',
          diagnostic: boundedDiagnostic(
            `${String(publicationError)}; rollback: ${String(rollbackError)}`,
          ),
        });
      }
      throw publicationError;
    }
    if (fileSystem.exists(backup)) fileSystem.remove(backup);
  } finally {
    if (fileSystem.exists(stage)) fileSystem.remove(stage);
  }
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
