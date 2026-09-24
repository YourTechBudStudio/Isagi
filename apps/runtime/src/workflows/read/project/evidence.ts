import { sql, type SQL } from 'drizzle-orm';

import type { WorkflowEvidenceDto } from '@isagi/contracts';

import { workflowEvidence } from '../../../persistence/schema.js';

/**
 * Projecting author-selected evidence.
 *
 * A record is a single-table read: placement, identity, content reference and source are all copied
 * onto the row at capture, so a listing is one indexed scan and a record reads as evidence on its
 * own. The only joins are to `workflow_operations`, twice, to turn two row ids into the opaque keys
 * the wire uses.
 *
 * Nothing here claims the content is still on disk. A list of a thousand rows must not stat a
 * thousand files; availability is learned at fetch time, exactly as the payload route already
 * teaches a client to learn it.
 */

type EvidenceRow = typeof workflowEvidence.$inferSelect;

export function evidenceDto(
  row: EvidenceRow & {
    readonly operationKey: string;
    readonly sourceOperationKey: string | null;
  },
): WorkflowEvidenceDto {
  return {
    evidenceKey: row.evidenceKey,
    frameId: row.frameId,
    executionId: row.executionId,
    attemptId: row.attemptId,
    operationKey: row.operationKey,
    title: row.title,
    role: row.role,
    labels: JSON.parse(row.labelsJson) as WorkflowEvidenceDto['labels'],
    content: {
      kind: row.contentKind,
      mediaType: row.mediaType,
      byteSize: row.byteSize,
      contentRef: row.contentRef,
      sourcePath: row.sourcePath,
    },
    source:
      row.sourceKind === 'none'
        ? { kind: 'none' }
        : {
            kind: row.sourceKind,
            agentSessionId: row.sourceAgentSessionId,
            operationKey: row.sourceOperationKey,
            // `none` belongs to the `none` kind alone; the column's enum is wider than this arm.
            attribution: row.sourceAttribution === 'none' ? 'unresolved' : row.sourceAttribution,
          },
    artifactHash: row.artifactHash,
    capturedAt: row.capturedAt,
  };
}

/**
 * Membership of an execution's subtree: itself, plus every execution beneath its child frames.
 *
 * One recursive CTE rather than a walk in TypeScript, so a filtered listing stays a single query and
 * pages correctly. It terminates because nesting is frames within one run — a frame's parent is an
 * execution of the same run, and there are no child runs — which is also why the story's "evidence
 * always remains under the launched root run" holds without a bucket concept.
 *
 * This is the same relation `nestedExecutionIds` in `graph.ts` walks for the operation summary. The
 * two must agree: the dock's count and the list it opens are the same set by construction, and a
 * divergence here would make them disagree.
 */
export function subtreeExecutionIds(rootExecutionId: number): SQL {
  return sql`(
    WITH RECURSIVE subtree(execution_id) AS (
      SELECT ${rootExecutionId}
      UNION
      SELECT e.id
        FROM workflow_graph_frames f
        JOIN subtree s ON f.parent_execution_id = s.execution_id
        JOIN workflow_node_executions e ON e.frame_id = f.id
    )
    SELECT execution_id FROM subtree
  )`;
}

/** One `label=key:value` filter, split on the first colon. */
export interface LabelFilter {
  readonly key: string;
  readonly value: string;
}

/**
 * Splits the wire form. A label key cannot contain a colon — refused at capture — so the first one
 * is unambiguously the separator. A parameter with no colon at all matches nothing and is kept as a
 * filter rather than dropped, because silently ignoring it would report a wider result than asked.
 */
export function parseLabelFilters(values: readonly string[]): readonly LabelFilter[] {
  return values.map((entry) => {
    const separator = entry.indexOf(':');
    return separator === -1
      ? { key: entry, value: '' }
      : { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
}

/**
 * Label predicates over the stored JSON object.
 *
 * The rule is one sentence: **a filter collapses every representation of a value, and the collapse
 * is total.** Compared as text on both sides, so `round:2` matches the number `2` and the string
 * `"2"` alike — an author who wrote a numeric label and a person typing a filter should not have to
 * agree on JSON types. `json_extract` needs no index; a label filter is already bounded by the run.
 *
 * Booleans need the second spelling below because SQLite extracts a JSON `true` as the integer 1.
 * Matching *either* spelling is what keeps the collapse total: a partial collapse has exactly one
 * dead end and it is invisible. Matching only the rewritten spelling would leave a label holding the
 * string `"true"` unreachable — `approved:true` rewritten past it, `approved:1` never meeting it —
 * with no spelling an author could type and nothing to say so. Every stored value is now reachable
 * by at least one spelling.
 *
 * The cost is the collision the text rule already accepts in the other direction: `approved:true`
 * also matches a label holding the string `"1"`. That is a value being found under a synonym, not a
 * value that cannot be found at all.
 *
 * An absent key extracts to `NULL`, and `NULL IN (…)` is never true, so a filter on a label a record
 * does not carry correctly matches nothing.
 */
export function labelPredicates(filters: readonly LabelFilter[]): readonly SQL[] {
  return filters.map(
    (filter) =>
      sql`CAST(json_extract(${workflowEvidence.labelsJson}, ${'$.' + jsonPathKey(filter.key)}) AS TEXT) IN (${filter.value}, ${alternateSpelling(filter.value)})`,
  );
}

/**
 * The other way SQLite may hold the same value. Identity for everything but the two boolean words,
 * which a JSON `true`/`false` is extracted as `1`/`0`.
 */
function alternateSpelling(value: string): string {
  if (value === 'true') return '1';
  if (value === 'false') return '0';
  return value;
}

/**
 * A label key inside a `json_extract` path.
 *
 * Quoted, because a key may contain characters the bare path grammar does not accept — `.` and `[`
 * above all, both of which a capture allows. An embedded `"` is escaped so the path cannot be
 * broken out of; the result is still one path expression, matching nothing if the key is absurd.
 */
function jsonPathKey(key: string): string {
  return `"${key.replaceAll('"', '\\"')}"`;
}
