/**
 * The workflow authoring contract version. A bundle built against a different major contract is
 * rejected by the verifier and the runtime loader rather than being interpreted loosely.
 */
export const workflowContractVersion = 2 as const;

export const workflowBrandKinds = [
  'workflow',
  'graph',
  'state-field',
  'operation-node',
  'subgraph-node',
  'checkpoint-node',
  'edge',
  'outcome',
  'operation-result',
] as const;

export type WorkflowBrandKind = (typeof workflowBrandKinds)[number];

/**
 * Present on every SDK-constructed registration object.
 *
 * A workflow bundle embeds its own copy of this package, so the SDK instance inside an artifact is
 * never the runtime's instance. Recognition therefore reads plain data that survives bundling —
 * never `instanceof`, a symbol, or constructor identity.
 */
export interface WorkflowBrand {
  readonly isagiContract: typeof workflowContractVersion;
  readonly isagiKind: WorkflowBrandKind;
}

/**
 * Recognizes an SDK-constructed registration object across a bundle boundary. A value carrying a
 * different `isagiContract` is not branded for this contract; callers that care about the
 * difference (the verifier, the loader) read `isagiContract` themselves to report a stale bundle
 * as an unsupported contract rather than as a shape error.
 */
export function isWorkflowBranded<Kind extends WorkflowBrandKind>(
  value: unknown,
  kind: Kind,
): value is WorkflowBrand & { readonly isagiKind: Kind } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly isagiContract?: unknown; readonly isagiKind?: unknown };
  return candidate.isagiContract === workflowContractVersion && candidate.isagiKind === kind;
}

/** Reads the contract version off any candidate registration object, for diagnostics. */
export function readWorkflowContractVersion(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = (value as { readonly isagiContract?: unknown }).isagiContract;
  return typeof candidate === 'number' ? candidate : null;
}

export function brand<Kind extends WorkflowBrandKind>(
  kind: Kind,
): { readonly isagiContract: typeof workflowContractVersion; readonly isagiKind: Kind } {
  return { isagiContract: workflowContractVersion, isagiKind: kind };
}
