/**
 * Canonicalization: rewriting a path that arrived from elsewhere — the base tree, the dirty survey,
 * an inherited row — into the directory-entry spelling the inventory uses.
 *
 * Whether `docs/README.md` and `docs/readme.md` name one entry is a property of the destination
 * filesystem, not of the strings, so each component is asked of its parent's listing: a verbatim
 * name is itself, an alias is resolved to the one verbatim entry it lands on, and a missing name
 * keeps its own spelling (two names that do not both exist are never related). Only existing names
 * are ever respelled. Results are memoized per capture, per component and read mode.
 */

import { join } from 'node:path';

import { Effect } from 'effect';

import {
  PathChangedError,
  PathInspectionError,
  resolveAlias,
  type DirectorySnapshot,
  type ReadMode,
} from '../paths.js';

export type ComponentSpelling =
  | { readonly kind: 'verbatim' }
  | { readonly kind: 'absent' }
  /** The name is an alias of this verbatim entry of the same directory. */
  | { readonly kind: 'respelled'; readonly name: string }
  /** The name is an alias of several hard-linked entries; root-relative candidates. */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] };

export type CanonicalResult =
  | { readonly kind: 'resolved'; readonly authored: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] };

export interface Canonicalizer {
  /** How one name reads inside an already-authored parent (`''` for the root). */
  readonly component: (
    parentAuthored: string,
    name: string,
    mode: ReadMode,
  ) => Effect.Effect<ComponentSpelling, PathInspectionError | PathChangedError>;
  /** A whole root-relative path, component by component. */
  readonly canonicalize: (
    path: string,
    mode: ReadMode,
  ) => Effect.Effect<CanonicalResult, PathInspectionError | PathChangedError>;
}

/** `root` is the realpath-ed worktree root; `snapshot` is the capture's own directory view. */
export function makeCanonicalizer(snapshot: DirectorySnapshot, root: string): Canonicalizer {
  const memo = new Map<string, ComponentSpelling>();
  const joinRelative = (parent: string, name: string) =>
    parent === '' ? name : `${parent}/${name}`;

  const component: Canonicalizer['component'] = (parentAuthored, name, mode) =>
    Effect.gen(function* () {
      const key = `${mode}\0${parentAuthored}\0${name}`;
      const known = memo.get(key);
      if (known) return known;
      const parentAbsolute = parentAuthored === '' ? root : join(root, parentAuthored);
      const observed = yield* snapshot.observe(parentAbsolute, {
        fatal: mode === 'authoritative',
      });
      let spelling: ComponentSpelling;
      if (observed.kind === 'changed') {
        return yield* new PathChangedError({ path: parentAbsolute });
      } else if (observed.kind !== 'directory') {
        // Beneath a missing entry, a link or a file: no directory entry of this tree carries it.
        spelling = { kind: 'absent' };
      } else if (observed.names.has(name)) {
        spelling = { kind: 'verbatim' };
      } else {
        const probed = yield* Effect.tryPromise({
          try: () => snapshot.reader.lstat(join(parentAbsolute, name)),
          catch: (cause) => cause,
        }).pipe(
          Effect.map(() => true),
          Effect.catchAll((cause) => {
            const code = (cause as { code?: unknown } | null)?.code;
            return code === 'ENOENT' || code === 'ENOTDIR'
              ? Effect.succeed(false)
              : Effect.fail(new PathInspectionError({ path: join(parentAbsolute, name), cause }));
          }),
        );
        if (!probed) {
          spelling = { kind: 'absent' };
        } else {
          const resolved = yield* resolveAlias(
            snapshot,
            root,
            joinRelative(parentAuthored, name),
            mode,
          );
          spelling =
            resolved.kind === 'unique'
              ? {
                  kind: 'respelled',
                  name: resolved.entry.slice(resolved.entry.lastIndexOf('/') + 1),
                }
              : { kind: 'ambiguous', candidates: resolved.entries };
        }
      }
      memo.set(key, spelling);
      return spelling;
    });

  const canonicalize: Canonicalizer['canonicalize'] = (path, mode) =>
    Effect.gen(function* () {
      const names = path.split('/');
      let authored = '';
      for (const [index, name] of names.entries()) {
        const spelling = yield* component(authored, name, mode);
        if (spelling.kind === 'ambiguous') {
          return { kind: 'ambiguous', candidates: spelling.candidates } as const;
        }
        if (spelling.kind === 'absent') {
          // Nothing below a missing name exists either; the rest keeps its own spelling.
          const rest = names.slice(index).join('/');
          return { kind: 'resolved', authored: joinRelative(authored, rest) } as const;
        }
        authored = joinRelative(authored, spelling.kind === 'respelled' ? spelling.name : name);
      }
      return { kind: 'resolved', authored } as const;
    });

  return { component, canonicalize };
}
