import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Where Isagi keeps its data when neither `--data-dir` nor `ISAGI_DATA_DIR` names a directory. */
export const defaultDataDirectory = '~/.isagi';

/** The global config file's name inside the data directory. */
export const globalConfigFileName = 'config.yaml';

/** The global config file of `dataDirectory`. */
export function globalConfigPath(dataDirectory: string): string {
  return resolve(dataDirectory, globalConfigFileName);
}

/**
 * The data directory a process uses when nothing passes one explicitly: `ISAGI_DATA_DIR` when set and
 * non-empty, else the default, with `~` expanded the way the runtime expands it.
 */
export function resolveDataDirectory(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
}): string {
  const configured = input.env.ISAGI_DATA_DIR;
  const directory =
    configured === undefined || configured === '' ? defaultDataDirectory : configured;
  return normalizeHomePath(directory, input.home);
}

// `home` is injectable so callers that already resolved the runtime home once can
// thread it through instead of re-reading the environment, and so tests can exercise
// tilde behavior against a temporary home without mutating `process.env` in a suite
// that runs with test isolation disabled. The default preserves every existing call.
/** `input` with a leading `~` or `~/` expanded to `home`; any other input is returned unchanged. */
export function expandHomePath(input: string, home: string = homedir()): string {
  if (input === '~') {
    return home;
  }
  if (input.startsWith('~/')) {
    return resolve(home, input.slice(2));
  }
  return input;
}

/** `input` with `~` expanded, else resolved against the working directory. */
export function normalizeHomePath(input: string, home: string = homedir()): string {
  const expanded = expandHomePath(input, home);
  if (expanded !== input) return expanded;
  return resolve(input);
}
