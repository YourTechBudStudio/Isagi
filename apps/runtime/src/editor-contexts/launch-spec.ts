import path from 'node:path';

import type { ResolvedEditorInstallation } from '../editor-provisioning/index.js';

/**
 * The loopback host every editor incarnation binds to. IPv4 rather than
 * `localhost`, so the bind address, the probe origin, and the URL the pane
 * frames are the same literal string and cannot diverge through name
 * resolution.
 */
export const editorLoopbackHost = '127.0.0.1';

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

/** The absolute loopback origin the workbench is probed at and framed from. */
export function editorOrigin(host: string, port: number): string {
  return `http://${host}:${port}`;
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
  readonly port: number;
  readonly socketPath: string;
}): EditorLaunchSpec {
  const { installation } = input;
  return {
    command: installation.executablePath,
    args: [
      '--bind-addr',
      `${editorLoopbackHost}:${input.port}`,
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
      input.socketPath,
      // This flag and the positional path are a pair: the worktree opens with no
      // second folder step, and a fresh launch does not restore whatever folder
      // a previous incarnation had open.
      '--ignore-last-opened',
      input.worktreePath,
    ],
  };
}
