import type { ApiError } from '@isagi/contracts';
import type { RuntimeClientError } from '@isagi/runtime-client';

/**
 * A runtime-client failure reduced to the shape the UI reasons about. This is the
 * single authoritative classification of a rejected runtime effect; both the
 * runtime-error copy layer and the palette workflow-failure adapter consume it so
 * the `_tag` switch lives in exactly one place.
 */
export type ClassifiedRuntimeFailure =
  | { readonly kind: 'api'; readonly apiError: ApiError }
  | { readonly kind: 'transport' }
  | { readonly kind: 'decode'; readonly endpointId: string }
  | { readonly kind: 'unknown' };

const runtimeClientErrorTags: ReadonlySet<unknown> = new Set<RuntimeClientError['_tag']>([
  'RuntimeApiError',
  'RuntimeTransportError',
  'RuntimeDecodeError',
]);

/**
 * Classify a thrown/rejected runtime failure. `runApp` and Effect's own `runPromise` reject with
 * the failure value itself, so the value is classified as-is.
 */
export function classifyRuntimeFailure(error: unknown): ClassifiedRuntimeFailure {
  if (!isRuntimeClientError(error)) {
    return { kind: 'unknown' };
  }
  switch (error._tag) {
    case 'RuntimeApiError':
      return { kind: 'api', apiError: error.apiError };
    case 'RuntimeTransportError':
      return { kind: 'transport' };
    case 'RuntimeDecodeError':
      return { kind: 'decode', endpointId: error.endpointId };
  }
}

function isRuntimeClientError(error: unknown): error is RuntimeClientError {
  return (
    typeof error === 'object' &&
    error !== null &&
    '_tag' in error &&
    runtimeClientErrorTags.has(error._tag)
  );
}
