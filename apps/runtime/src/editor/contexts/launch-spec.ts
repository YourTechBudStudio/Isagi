import path from 'node:path';

import type { ResolvedEditorInstallation } from '../provisioning/install.js';

/**
 * The host every request to an incarnation names. Code Server listens on a UNIX
 * socket, not a TCP port, so this names no address: it is the one authority the
 * runtime presents to Code Server, on proxied requests and on the readiness
 * probe alike, so Code Server's own Origin-against-Host check always sees a
 * same-origin request once the runtime has admitted it.
 */
export const editorUpstreamHost = 'localhost';

/** The origin matching `editorUpstreamHost`. */
export const editorUpstreamOrigin = `http://${editorUpstreamHost}`;

/**
 * The longest a UNIX domain socket path may be before the platform refuses it.
 *
 * The real caps are 104 bytes on darwin and 108 on Linux; the lower one is used
 * everywhere so a worktree that launches on one platform launches on both. The
 * check is in bytes rather than characters because that is what the kernel
 * counts.
 */
export const maxSessionSocketPathBytes = 100;

export interface EditorLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The two sockets one incarnation owns: Code Server's HTTP listen socket and its
 * session socket.
 *
 * Listening on a socket rather than a loopback TCP port is what makes "Code
 * Server is reached only through the runtime" enforced rather than a
 * convention: the socket directory is private to the runtime's user (`0700`), so
 * no web page, through DNS rebinding or otherwise, can reach Code Server
 * directly.
 *
 * Both share one random token, so they are per-incarnation rather than
 * per-context: a replacement must not inherit a path a predecessor may still
 * hold open, and the context id alone would guarantee that it did. Every
 * character spent here comes out of `maxSessionSocketPathBytes`; the listen
 * socket is the longer of the two, so it is the one checked against the cap.
 */
export function editorIncarnationSockets(
  socketDirectory: string,
  editorContextId: number,
  token: string,
): { readonly listenSocketPath: string; readonly sessionSocketPath: string } {
  return {
    listenSocketPath: path.join(socketDirectory, `${editorContextId}-${token}-w.sock`),
    sessionSocketPath: editorSessionSocketPath(socketDirectory, editorContextId, token),
  };
}

/**
 * The session socket for one incarnation.
 *
 * The random token is what makes it per-incarnation rather than per-context: a
 * replacement must not inherit a path a predecessor may still hold open, and the
 * context id alone would guarantee that it did. Provisioning deliberately gives
 * the directory a four-character final segment because every character spent
 * here comes out of `maxSessionSocketPathBytes`.
 */
export function editorSessionSocketPath(
  socketDirectory: string,
  editorContextId: number,
  token: string,
): string {
  return path.join(socketDirectory, `${editorContextId}-${token}.sock`);
}

/**
 * The exact argument set for one Code Server incarnation.
 *
 * Structured argv, never a shell string: a worktree path containing a space is
 * a path, and must not be able to become a quoting bug.
 *
 * There are no environment overrides, deliberately. The PTY layer's login-shell
 * baseline is the whole environment — it already strips every `ISAGI_*` control
 * plus `HOST`, `PORT`, `ELECTRON_RUN_AS_NODE` and `VITE_ISAGI_RUNTIME_URL`,
 * while `HOME`, `PATH`, `SSH_AUTH_SOCK` and `GIT_*` survive for the Git workflow
 * inside the workbench. Code Server cannot read Isagi's own controls and can
 * still commit; adding anything here would re-decide a resolved question.
 */
export function editorLaunchSpec(input: {
  readonly installation: ResolvedEditorInstallation;
  readonly worktreePath: string;
  readonly listenSocketPath: string;
  readonly sessionSocketPath: string;
}): EditorLaunchSpec {
  const { installation } = input;
  return {
    command: installation.executablePath,
    args: [
      // `--bind-addr` is ignored when a socket is named; see `editorIncarnationSockets`.
      '--socket',
      input.listenSocketPath,
      '--auth',
      'none',
      '--disable-telemetry',
      '--disable-update-check',
      // Without this, the Git workflow inside the frame stops at a workspace
      // trust prompt the user cannot easily answer in an embedded iframe.
      '--disable-workspace-trust',
      '--user-data-dir',
      installation.userDataPath,
      '--extensions-dir',
      installation.extensionsPath,
      // The Isagi-owned config file. Code Server writes its own on first run
      // with a generated password if none is named; the flags stay
      // authoritative either way, so this only removes the user-level side
      // effect.
      '--config',
      installation.configPath,
      '--session-socket',
      input.sessionSocketPath,
      // This flag and the positional path are a pair: the worktree opens with no
      // second folder step, and a fresh launch does not restore whatever folder
      // a previous incarnation had open.
      '--ignore-last-opened',
      input.worktreePath,
    ],
  };
}
