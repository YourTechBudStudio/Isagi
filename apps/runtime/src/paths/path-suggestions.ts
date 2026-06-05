import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { Effect } from 'effect';

import { normalizeHomePath } from './path-utils.js';

export interface PathSuggestInput {
  readonly input: string;
  readonly limit?: number | undefined;
}

export function suggestPaths(input: PathSuggestInput) {
  return Effect.try({
    try: () => suggestDirectories(input.input, input.limit ?? 25),
    catch: toError,
  });
}

function suggestDirectories(input: string, limit: number) {
  const parsed = parseInput(input);
  if (!isWithinSuggestionsRoot(parsed.basePath)) {
    return {
      basePath: displayPath(parsed.basePath),
      input,
      suggestions: [],
    };
  }

  const entries = safeDirectoryEntries(parsed.basePath);
  const showHidden = parsed.filter.startsWith('.');
  const lowerFilter = parsed.filter.toLowerCase();

  const suggestions = entries
    .filter((entry) => entry.isDirectory)
    .filter((entry) => isWithinSuggestionsRoot(join(parsed.basePath, entry.name)))
    .filter((entry) => showHidden || !entry.name.startsWith('.'))
    .filter((entry) => entry.name.toLowerCase().startsWith(lowerFilter))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => {
      const path = displayPath(join(parsed.basePath, entry.name));
      return {
        path,
        label: entry.name,
        kind: 'directory' as const,
        hidden: entry.name.startsWith('.'),
      };
    });

  return {
    basePath: displayPath(parsed.basePath),
    input,
    suggestions,
  };
}

function parseInput(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return { basePath: homedir(), filter: '' };
  }

  const expanded = trimmed.startsWith('~')
    ? normalizeHomePath(trimmed)
    : isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(homedir(), trimmed);

  if (trimmed.endsWith('/') || trimmed.endsWith(sep)) {
    return { basePath: expanded, filter: '' };
  }

  return { basePath: dirname(expanded), filter: basename(expanded) };
}

function isWithinSuggestionsRoot(path: string) {
  try {
    const home = realpathSync(homedir());
    const resolved = realpathSync(path);
    return resolved === home || resolved.startsWith(`${home}${sep}`);
  } catch {
    return false;
  }
}

function safeDirectoryEntries(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory() || isDirectory(join(path, entry.name)),
    }));
  } catch {
    return [];
  }
}

function isDirectory(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Home-rooted paths always render with the tilde, regardless of how the input
// was typed (absolute, relative, or already-tilde). One consistent display form.
function displayPath(path: string) {
  const home = homedir();
  if (path === home || path.startsWith(`${home}${sep}`)) {
    return path === home ? '~' : `~/${path.slice(home.length + 1)}`;
  }
  return path;
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
