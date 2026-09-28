/**
 * A query without its unset fields, so an omitted flag is omitted on the wire rather than sent as
 * `undefined` (which the contract's optional fields do not accept).
 */
export function compact<T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) result[key] = value;
  }
  return result as { [K in keyof T]?: Exclude<T[K], undefined> };
}
