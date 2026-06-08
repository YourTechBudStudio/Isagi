import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function normalizeHomePath(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/')) {
    return resolve(homedir(), input.slice(2));
  }
  return resolve(input);
}
