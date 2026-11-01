/**
 * Where a proxied request goes: the editor context named by the first path segment, and the rest of the raw URL for
 * Code Server.
 *
 * Cut from the raw URL rather than the decoded route params, so percent-encoding and the query string reach Code
 * Server unchanged: `/editor/7/stable-abc/x?y=1` becomes `/stable-abc/x?y=1`. Null when the id is not a positive
 * integer or nothing follows it.
 */
export function editorProxyRequestTarget(
  rawUrl: string,
): { readonly editorContextId: number; readonly path: string } | null {
  const prefix = '/editor/';
  if (!rawUrl.startsWith(prefix)) return null;
  const slash = rawUrl.indexOf('/', prefix.length);
  if (slash === -1) return null;
  const segment = rawUrl.slice(prefix.length, slash);
  if (!/^[1-9][0-9]*$/u.test(segment)) return null;
  const editorContextId = Number(segment);
  if (!Number.isSafeInteger(editorContextId)) return null;
  return { editorContextId, path: rawUrl.slice(slash) };
}
