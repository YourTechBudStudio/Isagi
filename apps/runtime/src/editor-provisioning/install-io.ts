import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { Context, Data, Effect, Layer } from 'effect';

const execFileAsync = promisify(execFile);

// Everything in provisioning that touches the network, an archive, or a file
// mode lives behind this one service, so `install.ts` — which owns the ordering,
// the failure classification, and the publish semantics — is testable without
// either a socket or a 200 MB fixture.
//
// The seam is drawn at *fallible external effects*, not at "filesystem calls":
// receipt reading and writing stay in `receipt.ts` as ordinary synchronous work,
// because their correctness is about write ordering rather than about
// substituting an environment.

/**
 * One failure shape for every operation, because the caller's branch is on
 * *which stage* failed rather than on how it failed inside that stage.
 *
 * `status` and `output` are the two pieces of evidence the caller genuinely
 * discriminates on: an HTTP status separates a withdrawn release from a
 * transport fault, and a tool's stderr is the only thing that makes an
 * extraction failure diagnosable at all.
 */
export class EditorInstallIoError extends Data.TaggedError('EditorInstallIoError')<{
  readonly operation: 'download' | 'extract' | 'assert_executable' | 'prepare_editor_state';
  /** Set only when the server answered and the answer was not 2xx. */
  readonly status: number | null;
  /**
   * Bounded stderr from a tool this runtime invoked with arguments this runtime
   * authored. It is surfaced to the user in a provisioning diagnostic, the same
   * way `git` stderr already reaches the workspace API — a different trust class
   * from the foreign error internals `diagnostics/operational-cause.ts` refuses
   * to render.
   */
  readonly output: string | null;
  readonly cause: unknown;
}> {}

export interface EditorSharedStatePaths {
  readonly userDataPath: string;
  readonly extensionsPath: string;
  readonly sessionSocketDirectory: string;
  readonly configPath: string;
}

export interface EditorInstallIoService {
  /**
   * Streams `url` to `destination`, hashing as it goes, and returns the
   * lowercase hex sha-256 of what was actually written.
   *
   * Hashing the bytes on their way to disk rather than re-reading the file
   * afterwards is what makes the digest a statement about the artifact that was
   * installed, not about a file that happened to be at that path later.
   *
   * Cancellation is Effect interruption: the attempt deadline interrupts the
   * fiber, which aborts the request. There is deliberately no second
   * caller-supplied `AbortSignal` — one deadline, one cancellation mechanism.
   */
  readonly downloadTo: (input: {
    readonly url: string;
    readonly destination: string;
  }) => Effect.Effect<{ readonly sha256: string }, EditorInstallIoError>;
  /** `tar -xzf <archive> -C <into> --strip-components <n>`, the system-`tar`
   *  precedent already set by `git/git.command.ts` and `pty-processes/adapters/tmux.ts`. */
  readonly extractTarGz: (input: {
    readonly archive: string;
    readonly into: string;
    readonly stripComponents: number;
  }) => Effect.Effect<void, EditorInstallIoError>;
  /** `access(path, X_OK)` — proves the extracted tree is usable *before* a
   *  receipt claims it is. */
  readonly assertExecutable: (path: string) => Effect.Effect<void, EditorInstallIoError>;
  /**
   * Creates the shared editor-state directories and writes `config.yaml` if it
   * is absent.
   *
   * It belongs to provisioning rather than to launch because "the editor is
   * ready to launch" should be one fact with one owner. A missing extensions
   * directory discovered at launch time would surface as a mysterious editor
   * failure; discovered here it is an honest `install_unusable`.
   */
  readonly prepareEditorState: (input: {
    readonly editorsPath: string;
  }) => Effect.Effect<EditorSharedStatePaths, EditorInstallIoError>;
}

/**
 * The directory this runtime's session sockets live in.
 *
 * Deliberately *not* under the data directory, and this is the one shared path
 * that is not. A UNIX socket path is capped near 104 bytes by the kernel, and a
 * data directory's depth is unbounded — Isagi's own worktrees nest under
 * `data/.isagi/worktrees/<n>/<hash>/`, which alone crosses the cap. Anchoring
 * here makes the budget depend on the platform's temporary root rather than on
 * wherever the user keeps their projects.
 *
 * Keyed per runtime for two reasons: two Isagi runtimes sharing a data
 * directory must not contend for one socket path, and a directory this process
 * created is one no other process is holding open. The token is random rather
 * than the pid because pids are reused, and a reused pid after a crash would
 * point a fresh runtime at a predecessor's directory.
 *
 * On darwin `tmpdir()` is a per-user private directory already; on Linux it is
 * world-writable `/tmp`, which is why the directory is created `0700` and named
 * unpredictably rather than derived from anything an observer could guess.
 */
export function runtimeSessionSocketDirectory(): string {
  return join(tmpdir(), `isagi-editor-${randomBytes(6).toString('hex')}`);
}

export const EditorInstallIo = Context.GenericTag<EditorInstallIoService>('isagi/EditorInstallIo');

const maxToolOutputBytes = 2_048;

// code-server generates a config with a random password when none exists. Isagi
// launches with explicit flags that are authoritative, but the file is written
// anyway so the provider never invents state Isagi did not choose. `auth: none`
// on IPv4 loopback is this milestone's accepted posture; hardening is separate
// work.
const codeServerConfig = `# Managed by Isagi. Launch flags are authoritative; this file exists so
# code-server never generates a configuration Isagi did not choose.
auth: none
`;

/**
 * The editor settings Isagi seeds on first setup, and never again.
 *
 * `chat.disableAIFeatures` is VS Code's own master switch for the chat stack
 * bundled into this Code Server build — the workbench sets it itself when the
 * builtin chat extension is disabled. Isagi turns it off by default because an
 * embedded editor opened from a coding agent should not arrive with a second,
 * unrelated assistant already running in it.
 *
 * A default, not a policy. It is written with `wx`, so the moment this file
 * exists it belongs to the user: they can turn the feature back on in the
 * workbench and no later launch will argue. Rewriting it on every start would
 * both override that choice and destroy every other setting they had added.
 */
const codeServerUserSettings = `${JSON.stringify({ 'chat.disableAIFeatures': true }, null, 2)}\n`;

export function makeEditorInstallIo(): EditorInstallIoService {
  // Once per runtime, not once per call: every incarnation of every editor
  // context in this process shares the directory, and a caller that asked
  // twice must be told the same place both times.
  const sessionSocketDirectory = runtimeSessionSocketDirectory();

  return {
    downloadTo: ({ url, destination }) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(url, { signal, redirect: 'follow' });
          if (!response.ok || !response.body) {
            // Drain rather than leak the socket. The status is the whole payload
            // the caller needs; the body of an error response is not read.
            await response.body?.cancel();
            throw new HttpResponseError(response.status);
          }
          const hash = createHash('sha256');
          await pipeline(
            Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
            async function* (source) {
              for await (const chunk of source) {
                hash.update(chunk as Buffer);
                yield chunk;
              }
            },
            createWriteStream(destination),
            { signal },
          );
          return { sha256: hash.digest('hex') };
        },
        catch: (cause) =>
          new EditorInstallIoError({
            operation: 'download',
            status: cause instanceof HttpResponseError ? cause.status : null,
            output: null,
            cause,
          }),
      }),

    extractTarGz: ({ archive, into, stripComponents }) =>
      Effect.tryPromise({
        try: async (signal) => {
          await execFileAsync(
            'tar',
            ['-xzf', archive, '-C', into, '--strip-components', String(stripComponents)],
            { signal, maxBuffer: 1024 * 1024 },
          );
        },
        catch: (cause) =>
          new EditorInstallIoError({
            operation: 'extract',
            status: null,
            output: boundedToolOutput(cause),
            cause,
          }),
      }),

    assertExecutable: (path) =>
      Effect.tryPromise({
        try: () => access(path, fsConstants.X_OK),
        catch: (cause) =>
          new EditorInstallIoError({
            operation: 'assert_executable',
            status: null,
            output: null,
            cause,
          }),
      }),

    prepareEditorState: ({ editorsPath }) =>
      Effect.tryPromise({
        try: async (): Promise<EditorSharedStatePaths> => {
          const providerRoot = join(editorsPath, 'code-server');
          const paths = {
            userDataPath: join(providerRoot, 'user-data'),
            extensionsPath: join(providerRoot, 'extensions'),
            sessionSocketDirectory,
            configPath: join(providerRoot, 'config.yaml'),
          };
          await mkdir(paths.userDataPath, { recursive: true });
          // VS Code finds this through `--user-data-dir`, so the path is not on
          // `EditorSharedStatePaths`: nothing outside this function needs it.
          await mkdir(join(paths.userDataPath, 'User'), { recursive: true });
          await mkdir(paths.extensionsPath, { recursive: true });
          // `0700` because on Linux this sits in world-writable `/tmp`; the
          // sockets inside it are a local control channel for the workbench.
          await mkdir(paths.sessionSocketDirectory, { recursive: true, mode: 0o700 });
          try {
            // `wx` rather than an exists-check: the write either creates the file
            // or reports that someone else already did, with no window in between.
            await writeFile(paths.configPath, codeServerConfig, { encoding: 'utf8', flag: 'wx' });
          } catch (cause) {
            if (!isExistingFile(cause)) throw cause;
          }
          try {
            await writeFile(
              join(paths.userDataPath, 'User', 'settings.json'),
              codeServerUserSettings,
              {
                encoding: 'utf8',
                flag: 'wx',
              },
            );
          } catch (cause) {
            if (!isExistingFile(cause)) throw cause;
          }
          return paths;
        },
        catch: (cause) =>
          new EditorInstallIoError({
            operation: 'prepare_editor_state',
            status: null,
            output: null,
            cause,
          }),
      }),
  };
}

export const EditorInstallIoLive: Layer.Layer<EditorInstallIoService> = Layer.succeed(
  EditorInstallIo,
  makeEditorInstallIo(),
);

// Local to this module: it exists only to carry a status out of the `try` block
// and is never seen by a caller.
class HttpResponseError extends Error {
  constructor(readonly status: number) {
    super(`Request failed with status ${status}.`);
  }
}

function isExistingFile(cause: unknown) {
  return cause instanceof Error && (cause as { readonly code?: unknown }).code === 'EEXIST';
}

function boundedToolOutput(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null || !('stderr' in cause)) return null;
  const stderr: unknown = (cause as { readonly stderr?: unknown }).stderr;
  if (typeof stderr !== 'string') return null;
  const trimmed = stderr.trim();
  if (!trimmed) return null;
  // Bounded in bytes, as the name says. `slice` counts UTF-16 code units, so a
  // stderr of three-byte characters would have passed roughly 6 KiB through a
  // 2 KiB cap. Decoding the trailing window can split a leading character, which
  // `toString` renders as U+FFFD; that partial character is dropped rather than
  // shown.
  const bytes = Buffer.from(trimmed, 'utf8');
  if (bytes.byteLength <= maxToolOutputBytes) return trimmed;
  return bytes
    .subarray(bytes.byteLength - maxToolOutputBytes)
    .toString('utf8')
    .replace(/^\uFFFD+/, '');
}
