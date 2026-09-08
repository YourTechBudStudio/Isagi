import type { PathSuggestOutput } from '@isagi/contracts';

/**
 * The fake filesystem the command-palette fixture answers `POST /paths/suggestions`
 * from, and the response gate that decides *when* an answer is delivered.
 *
 * ## What this is not
 *
 * It is deliberately dumb. It does no symlink resolution, no chunking, no collator
 * work, no permission modelling, and no home expansion. It is a flat list of
 * directory paths spelled exactly the way a runtime would spell them — `~/…` under
 * the runtime's home, absolute everywhere else — matched with plain string
 * operations.
 *
 * That is the point. The web layer treats suggestion strings as opaque
 * runtime-owned text, so the fixture's job is to hand back plausible runtime
 * spellings and record what it was asked, nothing more. Real listing behaviour —
 * scope, ordering exactness, hidden-name rules, symlinks, permissions, event-loop
 * yielding — is proved against a real filesystem in
 * `apps/runtime/src/paths/path.suggestions.test.ts`. Nothing here is evidence about
 * any of that, and a browser test must never be written as though it were.
 *
 * The one behaviour it does mirror faithfully is *input parsing*, because that is
 * the half the frontend's descent and trailing-separator rules are built on: a
 * trailing separator lists children, anything else filters the last segment against
 * its parent's children.
 */

/**
 * Directory paths, in runtime spelling. Home descendants carry the tilde; anything
 * else is absolute — including `/srv/deploy`, which exists so an outside-home
 * payload can be asserted verbatim (phase 04 removed the home confinement that once
 * made such a path unreachable).
 *
 * The shape is chosen for what the scenarios need rather than for realism:
 * `~/work` has enough children to cycle through and wrap around, `~/solo` has
 * exactly one child so a single-row wrap is observable, `~/empty` has none, and
 * `~/work/isagi` has children so a typed trailing-slash buffer has something to
 * load underneath it.
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
export interface ParsedSuggestionInput {
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
export function parseSuggestionInput(input: string): ParsedSuggestionInput {
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

export interface ResponseGate {
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
  /** Request ids currently waiting, in arrival order. */
  readonly heldIds: () => readonly number[];
}

/**
 * Deterministic response scheduling: a request either answers immediately or waits
 * until the test releases it by id.
 *
 * Ids rather than queue positions, because a queue shrinks as it drains and an index
 * into it silently retargets. This replaces the timer-based control the plan
 * originally proposed for these routes — a delay can only *probably* reverse two
 * responses, while a gate does it by construction. The fixture's older
 * `setRunDelay`, which existing command specs depend on, is deliberately left alone;
 * see the note beside it in `fake-runtime.ts`.
 *
 * This removes timing coordination from ordering assertions. It does not make
 * browser tests flake-free in general, and it does not remove the production 80 ms
 * suggestion debounce — a spec still has to observe a request before it can release
 * one.
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
    heldIds: () => [...waiting.keys()],
  };
}
