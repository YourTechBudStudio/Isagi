import { Effect } from 'effect';

import { workflowListPageLimitMaximum } from '@isagi/contracts';

import { CliFailure } from './errors.js';

interface Page {
  readonly nextCursor: string | null;
}

/**
 * Every page of one listing, in server order, at the largest page size the contract allows.
 *
 * Only composed commands use this (`checkpoints inspect --resolved` and `--manifest`); every other
 * command reads exactly one page and hands its `nextCursor` back to the caller. A page that repeats
 * a cursor already followed would loop forever, so it is reported as an invalid response instead.
 */
export function collectPages<P extends Page, Item, E, R>(
  fetchPage: (query: {
    readonly cursor?: string;
    readonly limit: number;
  }) => Effect.Effect<P, E, R>,
  itemsOf: (page: P) => readonly Item[],
): Effect.Effect<Item[], E | CliFailure, R> {
  return Effect.gen(function* () {
    const items: Item[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = yield* fetchPage(
        cursor === undefined
          ? { limit: workflowListPageLimitMaximum }
          : { cursor, limit: workflowListPageLimitMaximum },
      );
      items.push(...itemsOf(page));
      if (page.nextCursor === null) return items;
      if (seen.has(page.nextCursor)) {
        return yield* Effect.fail(
          CliFailure.of(
            'runtime_response_invalid',
            'The runtime returned a page cursor it had already returned; stopping instead of looping.',
            { cursor: page.nextCursor },
          ),
        );
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  });
}
