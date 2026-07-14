import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve } from 'node:path';

function expandHomePath(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/')) {
    return resolve(homedir(), input.slice(2));
  }
  return input;
}

export function normalizeHomePath(input: string): string {
  const expanded = expandHomePath(input);
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
