import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { Data, Effect } from 'effect';

/** `executable`, not `name`: a `name` field would overwrite the error's own `Error.name`. */
export class ExecutableNotFound extends Data.TaggedError('ExecutableNotFound')<{
  readonly executable: string;
}> {}

/**
 * The absolute path of the first `<dir>/<name>` on `pathValue` that is an executable file, the way
 * a shell would find it. For launchers that need an absolute executable rather than a name the
 * child process resolves itself.
 */
export const resolveExecutableOnPath = (
  name: string,
  pathValue: string | undefined,
): Effect.Effect<string, ExecutableNotFound> =>
  Effect.suspend(() => {
    for (const directory of (pathValue ?? '').split(delimiter)) {
      // An empty or relative entry would resolve against the runtime's cwd, which no user expects.
      if (directory === '' || !isAbsolute(directory)) continue;
      const candidate = resolve(join(directory, name));
      if (isExecutableFile(candidate)) return Effect.succeed(candidate);
    }
    return Effect.fail(new ExecutableNotFound({ executable: name }));
  });

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
