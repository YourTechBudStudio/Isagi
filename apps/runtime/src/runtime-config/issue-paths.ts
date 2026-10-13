import { type Schema, SchemaIssue } from 'effect';

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Where a config decode failed, as dotted paths below `prefix` (`<root>` for the document itself).
 * Issue messages are never read: they can echo the offending value, and a config value can be a key.
 */
export function issuePaths(
  error: Schema.SchemaError,
  prefix: ReadonlyArray<PropertyKey> = [],
): ReadonlyArray<string> {
  const paths = formatter(error.issue).issues.map((issue) =>
    joinIssuePath([...prefix, ...(issue.path ?? []).map(segmentKey)]),
  );
  return [...new Set(paths)];
}

/** `segments` joined with `.`, or `<root>` when empty. */
export function joinIssuePath(segments: ReadonlyArray<PropertyKey>): string {
  return segments.length === 0 ? '<root>' : segments.map(String).join('.');
}

function segmentKey(segment: PropertyKey | { readonly key: PropertyKey }): PropertyKey {
  return typeof segment === 'object' ? segment.key : segment;
}
