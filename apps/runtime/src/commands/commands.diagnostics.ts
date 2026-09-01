import {
  coordinates,
  describeCause,
  recognizeError,
  type CauseRecognizer,
  type RecognizedError,
} from '../diagnostics/operational-cause.js';
import { CommandError } from './commands.errors.js';

// The commands domain's view of the shared trust boundary
// (`diagnostics/operational-cause.ts`), which owns the actual rule: a rendered
// failure is composed from fields this codebase authored, never copied from an
// error's own text.
//
// The only thing this file adds is `CommandError` — the one recognizer that
// names a configured command, which is why it cannot live in a module every
// other domain imports. Everything else, including the depth bound and both
// allowlists, is the shared classifier's.
//
// Every commands call site uses `describeCommandCause`, including those that can
// currently only receive PTY or database failures. The boundary's classifier
// stays total that way, instead of asking each caller to predict which error
// members can reach it.

const recognizeCommandCause: CauseRecognizer = (value): RecognizedError | null => {
  if (value instanceof CommandError) {
    // The configured command name identifies which command failed. It is a
    // config-authored identifier, not the shell command line it runs.
    return {
      label: `Command error ${value.code}${coordinates({
        worktree: value.worktreeId,
        command: value.commandName,
      })}`,
      cause: value.cause,
    };
  }
  return recognizeError(value);
};

export function describeCommandCause(cause: unknown, depth = 0): string {
  return describeCause(cause, recognizeCommandCause, depth);
}
