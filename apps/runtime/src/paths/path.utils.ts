import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve } from 'node:path';

// `home` is injectable so callers that already resolved the runtime home once can
// thread it through instead of re-reading the environment, and so tests can exercise
// tilde behavior against a temporary home without mutating `process.env` in a suite
// that runs with test isolation disabled. The default preserves every existing call.
function expandHomePath(input: string, home: string = homedir()): string {
  if (input === '~') {
    return home;
  }
  if (input.startsWith('~/')) {
    return resolve(home, input.slice(2));
  }
  return input;
}

export function normalizeHomePath(input: string, home: string = homedir()): string {
  const expanded = expandHomePath(input, home);
  if (expanded !== input) return expanded;
  return resolve(input);
}

export function normalizeAbsoluteHomePath(input: string): string {
  if (input.trim().length === 0)
    throw new Error(`Path must not be empty: ${JSON.stringify(input)}.`);

  const expanded = expandHomePath(input);

  if (!isAbsolute(expanded)) {
    throw new Error(
      `Path must be absolute or use ~ for the current user home directory: ${JSON.stringify(input)}.`,
    );
  }

  return normalize(expanded);
}
