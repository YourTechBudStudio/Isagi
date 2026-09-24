import { createHash } from 'node:crypto';

import { Data } from 'effect';

/**
 * Opaque pagination cursors and recovery tokens.
 *
 * A cursor is the runtime's own bookmark, not a client-constructible offset. It carries the route it
 * came from, the run it belongs to, the normalized filters it was produced under, the lower bound of
 * the read and the frozen high-water revision — so a cursor replayed against a different run, route,
 * filter set or boundary is refused instead of quietly serving somebody else's rows. Nothing in a
 * rejection restates those internals; a client recovers by starting the listing again.
 *
 * Consistency does not come from the token. It comes from revision-associated immutable snapshots
 * and a stable ordering key; the token only binds a continuation to the boundary it was taken at.
 */

export class WorkflowCursorRejected extends Data.TaggedError('WorkflowCursorRejected')<{
  readonly detail: string;
}> {}

/** The ordering position of the last row a page delivered. */
export type CursorKey = readonly (string | number)[];

/**
 * The exact shape of a listing's ordering key.
 *
 * Declared per binding rather than checked loosely, because a key is fed straight into a query's
 * ordering predicate: a revision cursor holding a string becomes `NaN` in a comparison, and a
 * caller who edits one should meet the same stable rejection as any other unusable cursor rather
 * than a database error or a page ordered by nothing.
 */
export type CursorKeyShape = readonly ('string' | 'number')[];

/** A single row id or revision — what most listings page by. */
export const revisionKey: CursorKeyShape = ['number'];
/** An execution and a call index: the durable call position operations page by. */
export const callPositionKey: CursorKeyShape = ['number', 'number'];
/** A checkpoint manifest item: the layer's checkpoint row id, then -1 for the layer or the row's seq. */
export const layerEntryKey: CursorKeyShape = ['number', 'number'];
/** A start timestamp and an execution id: the waterfall's stable order. */
export const startedAtKey: CursorKeyShape = ['string', 'number'];

/** What a continuation must match to be a continuation of *this* listing. */
export interface CursorBinding {
  readonly route: string;
  readonly runId: number | null;
  readonly filters: unknown;
  /** The ordering key this route pages by, checked exactly on the way back in. */
  readonly key: CursorKeyShape;
  /** Recovery reads only: the lower bound. A different bound is a different listing. */
  readonly since?: number | undefined;
}

/** What a continuation carries forward rather than re-deriving. */
export interface DecodedCursor {
  readonly key: CursorKey;
  /**
   * The boundary the first page froze.
   *
   * Carried by the cursor rather than recomputed, because a run that advanced between two pages
   * would otherwise move the boundary out from under the continuation and every page after the
   * first would be refused. A client may still pass the snapshot token to read two routes against
   * the same boundary; the two must agree.
   */
  readonly highWater: number | undefined;
}

interface CursorPayload {
  readonly v: 1;
  readonly route: string;
  readonly runId: number | null;
  readonly filters: string;
  readonly since?: number;
  readonly key: CursorKey;
  readonly highWater?: number;
}

const cursorVersion = 1;

export function encodeCursor(binding: CursorBinding, key: CursorKey, highWater?: number): string {
  // The same check the decoder applies, so a route that encodes a key its own binding does not
  // describe fails here rather than handing out a cursor nothing will accept.
  decodeKey(key, binding.key);
  const payload = {
    v: cursorVersion,
    route: binding.route,
    runId: binding.runId,
    filters: fingerprint(binding.filters),
    ...(binding.since === undefined ? {} : { since: binding.since }),
    ...(highWater === undefined ? {} : { highWater }),
    key,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor and proves it belongs to this request.
 *
 * Every mismatch is the same answer to the client — the cursor is not one this read will honour —
 * because the difference between "another run's cursor" and "a tampered one" is a runtime detail,
 * not a client's decision.
 */
export function decodeCursor(cursor: string, binding: CursorBinding): DecodedCursor {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw new WorkflowCursorRejected({ detail: 'unreadable' });
  }
  if (payload?.v !== cursorVersion) throw new WorkflowCursorRejected({ detail: 'version' });
  if (payload.route !== binding.route) throw new WorkflowCursorRejected({ detail: 'route' });
  if (payload.runId !== binding.runId) throw new WorkflowCursorRejected({ detail: 'run' });
  if (payload.filters !== fingerprint(binding.filters)) {
    throw new WorkflowCursorRejected({ detail: 'filters' });
  }
  if (payload.since !== binding.since) throw new WorkflowCursorRejected({ detail: 'bounds' });
  return { key: decodeKey(payload.key, binding.key), highWater: decodeRevision(payload.highWater) };
}

/** Exactly the arity and the types this listing orders by — no extra parts, and no coercion. */
function decodeKey(key: unknown, shape: CursorKeyShape): CursorKey {
  if (!Array.isArray(key) || key.length !== shape.length) {
    throw new WorkflowCursorRejected({ detail: 'key' });
  }
  for (const [index, expected] of shape.entries()) {
    const part: unknown = key[index];
    const usable =
      expected === 'string'
        ? typeof part === 'string' && part.length > 0
        : typeof part === 'number' && Number.isFinite(part);
    if (!usable) throw new WorkflowCursorRejected({ detail: 'key' });
  }
  return key as CursorKey;
}

/**
 * A revision a caller hands back is still a revision, and nothing else.
 *
 * Absent is fine — an ordinary listing freezes no boundary. Anything present has to be a whole,
 * non-negative, finite number, because everything downstream treats it as a revision the run really
 * reached.
 */
function decodeRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkflowCursorRejected({ detail: 'boundary' });
  }
  return value;
}

/**
 * The boundary a paginated recovery read runs against.
 *
 * A continuation keeps the boundary its first page froze; a caller may name one explicitly with a
 * snapshot token so two routes read the same moment; and a first page with neither freezes the
 * revision the run is on now. A cursor and a token that disagree are refused rather than silently
 * preferring one.
 */
export function boundaryFor(input: {
  readonly cursor: DecodedCursor | null;
  readonly token: number | null;
  readonly current: number;
}): number {
  const fromCursor = input.cursor?.highWater;
  if (fromCursor !== undefined && input.token !== null && fromCursor !== input.token) {
    throw new WorkflowCursorRejected({ detail: 'boundary' });
  }
  const boundary = fromCursor ?? input.token ?? input.current;
  // A boundary the run has not reached is refused rather than honoured. Revisions only grow, so a
  // frozen boundary can never legitimately exceed the run's revision now — and honouring one would
  // let a completed page acknowledge coverage of revisions that do not exist yet, which is exactly
  // the false acknowledgement the whole recovery protocol is built to prevent. Tokens are opaque,
  // not trusted: the runtime's honesty cannot rest on a client not editing one.
  if (boundary > input.current) throw new WorkflowCursorRejected({ detail: 'boundary' });
  return boundary;
}

/**
 * The boundary a recovery read was frozen at, shared between the executions and events routes so
 * they can page against the same revision rather than two independently moving ones.
 */
export function encodeSnapshotToken(runId: number, highWaterRevision: number): string {
  return Buffer.from(
    JSON.stringify({ v: cursorVersion, runId, highWaterRevision }),
    'utf8',
  ).toString('base64url');
}

export function decodeSnapshotToken(token: string, runId: number): number {
  let payload: { v?: number; runId?: number; highWaterRevision?: number };
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as typeof payload;
  } catch {
    throw new WorkflowCursorRejected({ detail: 'unreadable' });
  }
  if (payload?.v !== cursorVersion) throw new WorkflowCursorRejected({ detail: 'version' });
  if (payload.runId !== runId) throw new WorkflowCursorRejected({ detail: 'run' });
  const revision = decodeRevision(payload.highWaterRevision);
  if (revision === undefined) throw new WorkflowCursorRejected({ detail: 'boundary' });
  return revision;
}

/** Normalized so key order in a query object cannot make two identical filter sets look different. */
function fingerprint(filters: unknown): string {
  return createHash('sha256').update(stableJson(filters)).digest('hex').slice(0, 16);
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}
