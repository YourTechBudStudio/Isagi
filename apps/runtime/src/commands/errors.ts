import { Data } from 'effect';

import type { WorktreeCommandsRejectionReason } from '@isagi/contracts';

import { coordinates, describeSafely, type SafeDiagnostic } from '../platform/diagnostics/index.js';
import { DatabaseError } from '../platform/persistence/index.js';

export class CommandError
  extends Data.TaggedError('CommandError')<{
    readonly code: WorktreeCommandsRejectionReason;
    readonly message: string;
    readonly worktreeId?: number | undefined;
    readonly commandName?: string | undefined;
    readonly cause?: unknown;
  }>
  implements SafeDiagnostic
{
  // The configured command name identifies which command failed. It is a
  // config-authored identifier, not the shell command line it runs.
  [describeSafely]() {
    return {
      label: `Command error ${this.code}${coordinates({
        worktree: this.worktreeId,
        command: this.commandName,
      })}`,
      cause: this.cause,
    };
  }
}

export type CommandServiceError = CommandError | DatabaseError;
