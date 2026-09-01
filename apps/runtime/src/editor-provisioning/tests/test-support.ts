import { constants as fsConstants, accessSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Effect } from 'effect';

import {
  EditorInstallIoError,
  type EditorInstallIoService,
  type EditorSharedStatePaths,
} from '../install-io.js';
import { codeServerManifest } from '../manifest.js';

export const pinnedVersion = codeServerManifest.version;
export const testArtifact = codeServerManifest.artifacts['darwin-arm64'];

export interface InstallIoRecorder {
  readonly io: EditorInstallIoService;
  /** Operation names in call order — the evidence behind "the receipt fast path
   *  performs zero IO". */
  readonly calls: string[];
}

export interface InstallIoBehaviour {
  /** Digest the download reports. Defaults to the pinned artifact's, i.e. a
   *  successful verification. */
  readonly downloadedSha256?: string;
  readonly downloadFailure?: { readonly status: number | null };
  readonly extractFailure?: { readonly output: string | null };
  /** When true, extraction produces a tree with no executable at all. */
  readonly extractWithoutExecutable?: boolean;
  readonly prepareEditorStateFails?: boolean;
  /** Runs before each operation; lets a test observe published state at each stage. */
  readonly observe?: () => Effect.Effect<void>;
}

/**
 * A substituted IO seam that still performs the *filesystem* half of its work
 * for real.
 *
 * Extraction genuinely creates a tree and `assertExecutable` genuinely checks a
 * mode, so staging cleanup, the publish rename, and the executable gate are
 * exercised against a real filesystem; only the network and `tar` are faked.
 * A fully in-memory double would have made every path assertion vacuous.
 */
export function recordingInstallIo(behaviour: InstallIoBehaviour = {}): InstallIoRecorder {
  const calls: string[] = [];
  const record = (operation: string) =>
    Effect.zipRight(
      Effect.sync(() => {
        calls.push(operation);
      }),
      behaviour.observe?.() ?? Effect.void,
    );

  const io: EditorInstallIoService = {
    downloadTo: ({ destination }) =>
      Effect.zipRight(
        record('downloadTo'),
        Effect.suspend(() => {
          if (behaviour.downloadFailure) {
            return Effect.fail(
              new EditorInstallIoError({
                operation: 'download',
                status: behaviour.downloadFailure.status,
                output: null,
                cause: new Error('download failed'),
              }),
            );
          }
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, 'archive bytes');
          return Effect.succeed({
            sha256: behaviour.downloadedSha256 ?? testArtifact.sha256,
          });
        }),
      ),

    extractTarGz: ({ into }) =>
      Effect.zipRight(
        record('extractTarGz'),
        Effect.suspend(() => {
          if (behaviour.extractFailure) {
            return Effect.fail(
              new EditorInstallIoError({
                operation: 'extract',
                status: null,
                output: behaviour.extractFailure.output,
                cause: new Error('tar failed'),
              }),
            );
          }
          mkdirSync(into, { recursive: true });
          if (!behaviour.extractWithoutExecutable) {
            writeExecutable(join(into, testArtifact.executablePath));
          }
          return Effect.void;
        }),
      ),

    assertExecutable: (path) =>
      Effect.zipRight(
        record('assertExecutable'),
        Effect.try({
          try: () => accessSync(path, fsConstants.X_OK),
          catch: (cause) =>
            new EditorInstallIoError({
              operation: 'assert_executable',
              status: null,
              output: null,
              cause,
            }),
        }),
      ),

    prepareEditorState: ({ editorsPath }) =>
      Effect.zipRight(
        record('prepareEditorState'),
        Effect.suspend(() => {
          if (behaviour.prepareEditorStateFails) {
            return Effect.fail(
              new EditorInstallIoError({
                operation: 'prepare_editor_state',
                status: null,
                output: null,
                cause: new Error('editor state failed'),
              }),
            );
          }
          const providerRoot = join(editorsPath, 'code-server');
          const paths: EditorSharedStatePaths = {
            userDataPath: join(providerRoot, 'user-data'),
            extensionsPath: join(providerRoot, 'extensions'),
            sessionSocketDirectory: join(providerRoot, 'sock'),
            configPath: join(providerRoot, 'config.yaml'),
          };
          mkdirSync(paths.userDataPath, { recursive: true });
          mkdirSync(paths.extensionsPath, { recursive: true });
          mkdirSync(paths.sessionSocketDirectory, { recursive: true });
          writeFileSync(paths.configPath, 'auth: none\n');
          return Effect.succeed(paths);
        }),
      ),
  };

  return { io, calls };
}

export function writeExecutable(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}
