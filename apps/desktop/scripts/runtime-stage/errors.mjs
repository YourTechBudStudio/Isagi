import { Data } from 'effect';

export class StageOperationError extends Data.TaggedError('StageOperationError') {
  get message() {
    const location = this.path ? ` at ${this.path}` : '';
    return `Runtime stage ${this.operation} failed${location}: ${errorMessage(this.cause)}`;
  }
}

export class StageValidationError extends Data.TaggedError('StageValidationError') {
  get message() {
    const location = this.path ? ` at ${this.path}` : '';
    return `Runtime stage validation failed${location}: ${this.reason}`;
  }
}

export class StageCommandError extends Data.TaggedError('StageCommandError') {
  get message() {
    const detail = this.timedOut
      ? 'timed out'
      : this.signal
        ? `signal ${this.signal}`
        : `exit code ${this.exitCode}`;
    return `Runtime stage command failed (${detail}): ${this.command} ${this.args.join(' ')}`;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
