import { Data } from 'effect';

import type { WorktreeCommandsRejectionReason } from '@isagi/contracts';

import { DatabaseError } from '../persistence/index.js';

export class CommandError extends Data.TaggedError('CommandError')<{
  readonly code: WorktreeCommandsRejectionReason;
  readonly message: string;
  readonly worktreeId?: number | undefined;
  readonly commandName?: string | undefined;
  readonly cause?: unknown;
}> {}

export type CommandServiceError = CommandError | DatabaseError;
