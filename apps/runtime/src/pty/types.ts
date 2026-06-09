import { Data } from 'effect';

import type { AgentHarness, PtySessionPurpose } from '@isagi/contracts';

export interface PtyStartInput {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cols: number;
  readonly rows: number;
  readonly onOutput: (data: string) => void;
  readonly onExit: (exit: PtyExit) => void;
}

export interface PtyExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface PtyHandle {
  readonly pid: number | null;
}

export class PtyStartError extends Data.TaggedError('PtyStartError')<{
  readonly command: string;
  readonly cwd: string;
  readonly cause: unknown;
}> {}

export class PtyWriteError extends Data.TaggedError('PtyWriteError')<{
  readonly ptySessionId?: number | undefined;
  readonly cause: unknown;
}> {}

export class PtyResizeError extends Data.TaggedError('PtyResizeError')<{
  readonly ptySessionId?: number | undefined;
  readonly cause: unknown;
}> {}

export class PtyKillError extends Data.TaggedError('PtyKillError')<{
  readonly ptySessionId?: number | undefined;
  readonly cause: unknown;
}> {}

export interface PtyAdapter {
  readonly name: 'node_pty';
  readonly start: (
    input: PtyStartInput,
  ) => import('effect').Effect.Effect<PtyHandle, PtyStartError>;
  readonly write: (
    handle: PtyHandle,
    data: string,
  ) => import('effect').Effect.Effect<void, PtyWriteError>;
  readonly resize: (
    handle: PtyHandle,
    size: { readonly cols: number; readonly rows: number },
  ) => import('effect').Effect.Effect<void, PtyResizeError>;
  readonly kill: (handle: PtyHandle) => import('effect').Effect.Effect<void, PtyKillError>;
}

export interface LaunchPtySessionInput {
  readonly worktreeId: number;
  readonly purpose: PtySessionPurpose;
  readonly harness: AgentHarness | null;
}

export interface PtySessionLaunchMetadata {
  readonly worktreeId: number;
  readonly surfaceId: number;
  readonly paneId: number;
  readonly ptySessionId: number;
  readonly command: string;
  readonly cwd: string;
  readonly logPath: string;
}
