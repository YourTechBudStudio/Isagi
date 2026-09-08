import type { PathSuggestOutput } from '@isagi/contracts';

/**
 * Runtime-spelled directory strings for browser interactions. Filesystem behavior
 * belongs in apps/runtime/src/paths/path.suggestions.test.ts.
 * Includes multiple, single, empty, nested, hidden, and outside-home cases.
 */
export const FIXTURE_PATH_TREE: readonly string[] = [
  '~/work',
  '~/work/isagi',
  '~/work/isagi/apps',
  '~/work/isagi/packages',
  '~/work/isagi-web',
  '~/work/inbox',
  '~/work/notes',
  '~/work/.hidden-cache',
  '~/solo',
  '~/solo/only-child',
  '~/empty',
  '/srv',
  '/srv/deploy',
  '/srv/deploy/releases',
  '/tmp',
];

/** How `parseSuggestionInput` split an input into "list this" and "starting with this". */
interface ParsedSuggestionInput {
  readonly basePath: string;
  readonly filter: string;
}

/**
 * Mirrors the runtime's `parseInput` for the cases this fixture serves: a trailing
 * separator means "list this directory's children"; otherwise the last segment is a
 * prefix filter against its parent. Root (`/`) and bare `~` list their own children.
 *
 * Unlike the runtime it never expands, resolves, or normalises — the tree is already
 * in runtime spelling, and normalising here would quietly hide a frontend that had
 * started rewriting paths it is supposed to pass through untouched.
 */
function parseSuggestionInput(input: string): ParsedSuggestionInput {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed === '~' || trimmed === '~/') {
    return { basePath: '~', filter: '' };
  }
  if (trimmed === '/') {
    return { basePath: '/', filter: '' };
  }
  if (trimmed.endsWith('/')) {
    return { basePath: trimmed.slice(0, -1), filter: '' };
  }
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) {
    return { basePath: cut === 0 ? '/' : '~', filter: trimmed.slice(cut + 1) };
  }
  return { basePath: trimmed.slice(0, cut), filter: trimmed.slice(cut + 1) };
}

const DEFAULT_LIMIT = 25;

/**
 * Direct children of `basePath` whose name starts with `filter`, case-insensitively,
 * in name order. Hidden names appear only for a `.`-prefixed filter, matching the
 * runtime's rule — the frontend has a `hidden` badge that would otherwise never be
 * reachable from this page.
 */
export function suggestFromTree(
  tree: readonly string[],
  input: string,
  limit: number | undefined,
): PathSuggestOutput {
  const { basePath, filter } = parseSuggestionInput(input);
  const prefix = basePath === '/' ? '/' : `${basePath}/`;
  const showHidden = filter.startsWith('.');
  const lowerFilter = filter.toLowerCase();

  const names = tree
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map((path) => path.slice(prefix.length))
    .filter((name) => name !== '')
    .filter(
      (name) => (showHidden || !name.startsWith('.')) && name.toLowerCase().startsWith(lowerFilter),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    basePath,
    input,
    suggestions: names.slice(0, limit ?? DEFAULT_LIMIT).map((name) => ({
      path: `${prefix}${name}`,
      label: name,
      kind: 'directory' as const,
      hidden: name.startsWith('.'),
    })),
  };
}

/** One request whose response has already been decided and is waiting to be delivered. */
interface HeldResponse {
  readonly deliver: () => void;
}

interface ResponseGate {
  /** Arm or disarm holding. Requests that arrive while armed wait for a release. */
  readonly hold: (held: boolean) => void;
  /**
   * Register an arrival whose response is already decided.
   *
   * `build` must only serialise values computed *before* this call. For mutations
   * that means the fixture's state has already changed by the time the request is
   * held: a held response is an acknowledgement in flight, not an operation waiting
   * to happen. Releasing it can therefore never apply the mutation a second time.
   */
  readonly arrive: (id: number, build: () => Response) => Promise<Response>;
  /** Deliver one held response by its request id. Unknown ids are ignored. */
  readonly release: (id: number) => void;
  /** Deliver every held response, oldest first. */
  readonly releaseAll: () => void;
}

/**
 * Release by stable request ID to control response ordering. Observe arrival after
 * the production debounce before releasing. Disarming does not drain held responses.
 */
export function createResponseGate(): ResponseGate {
  let held = false;
  const waiting = new Map<number, HeldResponse>();

  return {
    hold: (next) => {
      held = next;
    },
    arrive: (id, build) => {
      if (!held) {
        return Promise.resolve(build());
      }
      return new Promise<Response>((resolve) => {
        waiting.set(id, { deliver: () => resolve(build()) });
      });
    },
    release: (id) => {
      const entry = waiting.get(id);
      if (!entry) return;
      waiting.delete(id);
      entry.deliver();
    },
    releaseAll: () => {
      for (const [id, entry] of [...waiting]) {
        waiting.delete(id);
        entry.deliver();
      }
    },
  };
}
