import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Data, Effect } from 'effect';

import type { EditorProvisioningFailureReason } from '@isagi/contracts';

import type {
  EditorInstallIoError,
  EditorInstallIoService,
  EditorSharedStatePaths,
} from './install-io.js';
import type { CodeServerArtifact, EditorPlatformKey } from './manifest.js';
import {
  editorInstallReceiptMatches,
  readEditorInstallReceipt,
  writeEditorInstallReceipt,
} from './receipt.js';

/**
 * A modelled provisioning outcome, carrying the contract's own reason literal so
 * the failure, the service state, and the control-plane projection can never
 * disagree about what went wrong.
 *
 * `diagnostic` is composed exclusively from values this codebase authored: stage
 * names, the pinned version, an HTTP status, the two digests, and — for
 * extraction only — bounded stderr from a tool this runtime invoked with its own
 * arguments. No foreign error text is ever interpolated.
 */
export class EditorProvisioningFailure extends Data.TaggedError('EditorProvisioningFailure')<{
  readonly reason: EditorProvisioningFailureReason;
  readonly diagnostic: string | null;
}> {}

export interface ResolvedEditorInstallation extends EditorSharedStatePaths {
  readonly version: string;
  readonly installRoot: string;
  readonly executablePath: string;
}

export type EditorInstallPhase = 'downloading' | 'verifying' | 'extracting';

export interface ProvisionCodeServerInput {
  readonly io: EditorInstallIoService;
  readonly paths: { readonly toolsPath: string; readonly editorsPath: string };
  readonly artifact: CodeServerArtifact;
  readonly platformKey: EditorPlatformKey;
  readonly version: string;
  readonly onPhase: (phase: EditorInstallPhase) => Effect.Effect<void>;
}

/**
 * Resolve the pinned Code Server installation, downloading and verifying it only
 * if a matching receipt is not already on disk.
 *
 * Written as a function over an explicit `io` rather than as a service method:
 * the ordering and the failure classification below are the whole substance of
 * provisioning, and keeping them callable with a plain object makes every
 * failure path testable without building a layer.
 *
 * The step numbering matches program design §7.1.5.
 */
export function provisionCodeServer(
  input: ProvisionCodeServerInput,
): Effect.Effect<ResolvedEditorInstallation, EditorProvisioningFailure> {
  const { io, paths, artifact, platformKey, version, onPhase } = input;
  const installRoot = join(paths.toolsPath, 'code-server', version);
  const executablePath = join(installRoot, artifact.executablePath);

  return Effect.gen(function* () {
    // 1. The reuse fast path (AC2). A matching receipt plus a still-executable
    //    binary is a complete answer: no network call, and no re-hash of a
    //    ~200 MB tree to re-derive what the write ordering already proved.
    const receipt = readEditorInstallReceipt(installRoot);
    const reusable =
      receipt !== null && editorInstallReceiptMatches(receipt, { version, platformKey, artifact });
    if (reusable) {
      // The manifest's path, not the receipt's. `editorInstallReceiptMatches`
      // has already proved the two are equal; resolving from the manifest means
      // no filesystem target is ever derived from a persisted string.
      const usable = yield* io.assertExecutable(executablePath).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      if (usable) {
        // 8/9 for the reuse path: shared editor state is still prepared, so
        // "resolved" means the same thing whether or not a download happened.
        const shared = yield* prepareShared(io, paths.editorsPath);
        return { version, installRoot, executablePath, ...shared };
      }
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        // 2. Staging, owned by a finalizer so it is removed on success, on every
        //    modelled failure, on interruption, and on the attempt deadline.
        const staging = yield* acquireStaging(paths.toolsPath);
        const archivePath = join(staging, 'artifact.tar.gz');
        const treePath = join(staging, 'tree');

        // 3. Download, hashing in flight.
        yield* onPhase('downloading');
        const downloaded = yield* io
          .downloadTo({ url: artifact.url, destination: archivePath })
          .pipe(Effect.mapError((error) => downloadFailure(error, version)));

        // 4. Verify before anything is extracted, let alone published.
        yield* onPhase('verifying');
        if (downloaded.sha256 !== artifact.sha256) {
          return yield* new EditorProvisioningFailure({
            reason: 'integrity_mismatch',
            diagnostic: `Downloaded Code Server ${version} did not match its pinned checksum. Expected sha-256 ${artifact.sha256}, received ${downloaded.sha256}.`,
          });
        }

        // 5. Extract.
        yield* onPhase('extracting');
        yield* Effect.tryPromise({
          try: () => mkdir(treePath, { recursive: true }),
          catch: (cause) => cause,
        }).pipe(Effect.mapError(() => unusable(`could not create an extraction directory`)));
        yield* io
          .extractTarGz({
            archive: archivePath,
            into: treePath,
            stripComponents: artifact.stripComponents,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new EditorProvisioningFailure({
                  reason: 'extract_failed',
                  diagnostic: `Extracting Code Server ${version} failed.${error.output ? ` tar: ${error.output}` : ''}`,
                }),
            ),
          );

        // 6. Prove the tree is usable before a receipt is allowed to claim it is.
        yield* io
          .assertExecutable(join(treePath, artifact.executablePath))
          .pipe(
            Effect.mapError(() =>
              unusable(`the extracted archive has no executable at ${artifact.executablePath}`),
            ),
          );

        // 7. Publish. Uninterruptible: a deadline arriving between the rename and
        //    the receipt write would leave an install root that claims nothing,
        //    which the next attempt would have to clean up anyway.
        yield* publish({ installRoot, treePath, version, platformKey, artifact });

        // 8. Shared editor state, inside provisioning so "ready to launch" is one
        //    fact rather than two.
        const shared = yield* prepareShared(io, paths.editorsPath);

        // 9.
        return { version, installRoot, executablePath, ...shared };
      }),
    );
  });
}

function acquireStaging(toolsPath: string) {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const staging = join(toolsPath, '.staging', randomBytes(8).toString('hex'));
        await mkdir(staging, { recursive: true });
        return staging;
      },
      catch: (cause) => cause,
    }).pipe(Effect.mapError(() => unusable('could not create a staging directory'))),
    // Best-effort and infallible, as a finalizer must be. A staging directory
    // that outlives its attempt is wasted space; a finalizer that can fail is a
    // second failure mode on every exit path.
    (staging) =>
      Effect.promise(() => rm(staging, { recursive: true, force: true }).catch(() => {})),
  );
}

function publish(input: {
  readonly installRoot: string;
  readonly treePath: string;
  readonly version: string;
  readonly platformKey: EditorPlatformKey;
  readonly artifact: CodeServerArtifact;
}) {
  const { installRoot, treePath, version, platformKey, artifact } = input;
  return Effect.tryPromise({
    try: async () => {
      // Anything already here is an incomplete previous attempt: a complete one
      // would have returned at step 1. It is replaced rather than repaired.
      await rm(installRoot, { recursive: true, force: true });
      await mkdir(dirname(installRoot), { recursive: true });
      // Staging and the install root share `toolsPath`, so this is always a
      // same-filesystem rename and `EXDEV` cannot occur.
      await rename(treePath, installRoot);
      writeEditorInstallReceipt(installRoot, {
        receiptVersion: 1,
        version,
        platformKey,
        artifactSha256: artifact.sha256,
        executablePath: artifact.executablePath,
        completedAt: new Date().toISOString(),
      });
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.mapError(() => unusable('the verified installation could not be published')),
    Effect.uninterruptible,
  );
}

function prepareShared(io: EditorInstallIoService, editorsPath: string) {
  return io
    .prepareEditorState({ editorsPath })
    .pipe(
      Effect.mapError(() => unusable('the shared editor state directories could not be prepared')),
    );
}

function downloadFailure(error: EditorInstallIoError, version: string) {
  // A withdrawn or renamed release is a different operational fact from a
  // network fault: one is a pin that no longer resolves and will never succeed
  // on retry, the other is worth retrying immediately.
  if (error.status === 404 || error.status === 410) {
    return new EditorProvisioningFailure({
      reason: 'release_unavailable',
      diagnostic: `Code Server ${version} is no longer available at its pinned release URL (HTTP ${error.status}).`,
    });
  }
  // No foreign text. `fetch` reports transport faults as an opaque wrapper whose
  // own cause chain this runtime does not walk (see
  // `diagnostics/operational-cause.ts`), so the honest diagnostic names the
  // stage and, when the server answered at all, its status.
  return new EditorProvisioningFailure({
    reason: 'download_failed',
    diagnostic:
      error.status === null
        ? `Downloading Code Server ${version} did not complete.`
        : `Downloading Code Server ${version} failed with HTTP ${error.status}.`,
  });
}

function unusable(what: string) {
  return new EditorProvisioningFailure({
    reason: 'install_unusable',
    diagnostic: `Code Server could not be installed because ${what}.`,
  });
}
