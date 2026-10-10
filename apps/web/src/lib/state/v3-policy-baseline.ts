/**
 * The freshness, retention, retry and polling policy of every runtime-fact cache in the web app,
 * as React Query 5.101 actually applies it on the pre-migration branch (`84bfc65`).
 *
 * This is evidence, not configuration: nothing imports it at runtime. It was extracted by reading
 * the code, once, before the move to `effect/reactivity` atoms, so that the table test in
 * `policy.test.ts` ("every resource declares the freshness, retention, retry and polling policy
 * recorded in the v3 baseline") can prove each new query policy against what the app did before.
 * A deliberate deviation is an edit to *that test's* expectations with a comment and a
 * review-ledger entry; this file stays a record of v3 and is never edited to match new code.
 *
 * Semantics of each field, all in React Query's terms:
 *
 * - `staleTime` / `gcTime` are milliseconds; `Infinity` means never stale / never collected.
 * - `retry` is the number of retries after the first failed attempt (`false` = none). The delay
 *   before retry `n` (0-based) is {@link v3QueryDefaults}`.retryDelayMs(n)`: 1 s, 2 s, 4 s.
 * - `refetchOnFocus` / `refetchOnReconnect` mean "re-read when the document becomes visible / the
 *   browser comes back online, **if the data is stale and an observer is mounted**". With an
 *   infinite `staleTime` they therefore never fire, although the flag is set.
 * - `refetchInterval` is polling while an observer is mounted and the document is visible.
 * - `observers` lists per-observer overrides that apply only while that one component is mounted.
 * - `imperativeReads` lists `fetchQuery` call sites that read the same key outside a hook
 *   (read-after-write). They always read (`staleTime: 0`) and never retry (`fetchQuery`'s own
 *   default), whatever the family's policy says.
 *
 * Source references are `apps/web/src`-relative `file:line` at `84bfc65`; React Query internals are
 * `@tanstack/query-core@5.101.0` `build/modern` paths.
 */

/** Milliseconds; `Number.POSITIVE_INFINITY` stands for React Query's `Infinity`. */
type Millis = number;

export interface V3PollingPolicy {
  readonly everyMs: Millis;
  /** The condition under which the interval is active, in words. */
  readonly while: string;
}

export interface V3ObserverOverride {
  readonly observer: string;
  readonly staleTime?: Millis;
  readonly refetchInterval?: V3PollingPolicy;
  readonly enabled: string;
  readonly source: string;
}

export interface V3ImperativeRead {
  readonly staleTime: Millis;
  readonly retry: false;
  readonly sources: readonly string[];
}

export interface V3QueryPolicy {
  /** The React Query key shape, for humans. */
  readonly queryKey: string;
  readonly staleTime: Millis;
  readonly gcTime: Millis;
  readonly retry: number | false;
  readonly refetchOnFocus: boolean;
  readonly refetchOnReconnect: boolean;
  readonly refetchInterval: V3PollingPolicy | false;
  /** Where each value comes from; inherited defaults cite {@link v3QueryDefaults}. */
  readonly sources: readonly string[];
  readonly observers?: readonly V3ObserverOverride[];
  readonly imperativeReads?: V3ImperativeRead;
  readonly notes?: string;
}

const INFINITY = Number.POSITIVE_INFINITY;
const FIVE_MINUTES = 5 * 60_000;

/**
 * The client-wide defaults every query inherits unless it overrides them. The first three are set
 * by Isagi's `QueryClient`; the rest are React Query's own defaults, which the app never changed.
 */
export const v3QueryDefaults = {
  staleTime: 10_000,
  refetchOnFocus: true,
  refetchOnReconnect: true,
  gcTime: FIVE_MINUTES,
  retry: 3,
  retryDelayMs: (failureCount: number): Millis => Math.min(1_000 * 2 ** failureCount, 30_000),
  /** Reads start or continue only while the browser reports online; otherwise they pause. */
  networkMode: 'online',
  /** A mounting observer re-reads stale data. */
  refetchOnMount: true,
  /** Polling skips while the document is hidden; retries also wait for visibility. */
  refetchIntervalInBackground: false,
  sources: [
    'lib/query/client.ts:6 refetchOnReconnect',
    'lib/query/client.ts:7 refetchOnWindowFocus',
    'lib/query/client.ts:8 staleTime',
    'query-core retryer.js:86 retry default 3',
    'query-core retryer.js:7-9 defaultRetryDelay',
    'query-core removable.js:19-22 gcTime default 5 min',
    'query-core retryer.js:10-11,42-43 networkMode online; retries continue only while focused',
    'query-core queryObserver.js:448-456 refetchOnMount/focus/reconnect only when stale',
    'query-core queryClient.js:181-185 fetchQuery defaults retry to false',
  ],
} as const;

const defaults = {
  staleTime: v3QueryDefaults.staleTime,
  gcTime: v3QueryDefaults.gcTime,
  retry: v3QueryDefaults.retry,
  refetchOnFocus: v3QueryDefaults.refetchOnFocus,
  refetchOnReconnect: v3QueryDefaults.refetchOnReconnect,
  refetchInterval: false,
} as const;

/** The workflow family's shared shape: kept current by the event socket, never by time. */
const workflowLive = {
  staleTime: INFINITY,
  gcTime: FIVE_MINUTES,
  retry: false,
  refetchOnFocus: true,
  refetchOnReconnect: true,
  refetchInterval: false,
} as const;

/**
 * The 19 key families. Keys are the family names the Effect state layer uses where one exists
 * (web-state §3.1/§4.1); `terminalSessionInventory` has no atom in the new design.
 */
export const v3PolicyBaseline = {
  workspace: {
    queryKey: "['workspace']",
    ...defaults,
    sources: ['lib/workspace/queries.ts:90-95', 'lib/workspace/query-keys.ts:1'],
    imperativeReads: {
      staleTime: 0,
      retry: false,
      sources: [
        'lib/workspace/queries.ts:293-297',
        'lib/workspace/queries.ts:573-577',
        'lib/workspace/queries.ts:607-611',
        'lib/workspace/queries.ts:690-694',
        'lib/workspace/queries.ts:708-712',
        'lib/workspace/queries.ts:785-789',
      ],
    },
    notes:
      "Invalidating the ['workspace'] prefix also invalidates ['workspace','active-context'] (18 sites); web-state §3.2 drops that coupling.",
  },
  activeContext: {
    queryKey: "['workspace', 'active-context']",
    ...defaults,
    sources: ['lib/workspace/queries.ts:179-184', 'lib/workspace/query-keys.ts:2'],
  },
  worktreeCommands: {
    queryKey: "['worktree', worktreeId, 'commands']",
    ...defaults,
    sources: ['lib/workspace/queries.ts:105-125', 'lib/workspace/query-keys.ts:4-5'],
    observers: [
      {
        observer: 'CommandPalette (configured-commands section)',
        staleTime: 0,
        refetchInterval: { everyMs: 10_000, while: 'the palette is open' },
        enabled: 'palette open and a worktree is active',
        source: 'routes/workspace/CommandPalette.tsx:70,157-161',
      },
    ],
  },
  commandLogMetadata: {
    queryKey: "['worktree', worktreeId, 'commands', 'log-metadata', commandName]",
    ...defaults,
    sources: ['lib/workspace/queries.ts:127-138', 'lib/workspace/query-keys.ts:6-7'],
  },
  surfaceDetail: {
    queryKey: "['surface', surfaceId]",
    ...defaults,
    gcTime: INFINITY,
    sources: ['lib/workspace/queries.ts:199-214', 'lib/workspace/queries.ts:205 gcTime'],
    imperativeReads: {
      staleTime: 0,
      retry: false,
      sources: [
        'lib/workspace/activation.ts:60-64',
        'lib/palette/commands/surface-actions.ts:263-267',
      ],
    },
    notes:
      'Deleted surfaces are removed with removeQueries (lib/workspace/queries.ts:654, lib/workspace/runtime-events.ts:226-229).',
  },
  runtimeIdentity: {
    queryKey: "['runtime', 'identity']",
    ...defaults,
    staleTime: INFINITY,
    gcTime: INFINITY,
    sources: ['lib/workspace/workflow/queries.ts:65-73', 'lib/workspace/query-keys.ts:16'],
    notes:
      'Resolved from configuration, not fetched from the runtime; every workflow key is namespaced by it.',
  },
  workflowDescriptors: {
    queryKey:
      "['workflows', runtimeIdentity, 'descriptors', { worktreeId, surfaceId, paneId, agentSessionId }]",
    ...defaults,
    staleTime: 30_000,
    sources: [
      'lib/workspace/workflow/queries.ts:398-420',
      'lib/workspace/workflow/queries.ts:412 staleTime',
    ],
    notes:
      'Enabled only while the palette is open with a launch origin (routes/workspace/CommandPalette.tsx:143).',
  },
  workflowAttachedRuns: {
    queryKey: "['workflows', runtimeIdentity, 'attached']",
    staleTime: INFINITY,
    gcTime: v3QueryDefaults.gcTime,
    retry: false,
    refetchOnFocus: true,
    refetchOnReconnect: true,
    refetchInterval: false,
    sources: [
      'lib/workspace/workflow/queries.ts:88-105',
      'lib/workspace/workflow/queries.ts:102-103',
    ],
    notes:
      'Read through the runtime-events socket snapshot request (10 s answer timeout, lib/workspace/runtime-events.ts:32,44-62), not HTTP.',
  },
  workflowEvents: {
    queryKey: "['workflows', runtimeIdentity, 'events', runId]",
    ...workflowLive,
    sources: ['lib/workspace/workflow/queries.ts:125-134'],
  },
  workflowRun: {
    queryKey: "['workflows', runtimeIdentity, 'run', runId]",
    ...workflowLive,
    sources: ['lib/workspace/workflow/queries.ts:182-192'],
  },
  workflowStructure: {
    queryKey: "['workflows', runtimeIdentity, 'structure', runId, artifactHash]",
    ...workflowLive,
    gcTime: v3QueryDefaults.gcTime,
    sources: ['lib/workspace/workflow/queries.ts:241-255', 'gcTime inherited (not set)'],
  },
  workflowExecution: {
    queryKey: "['workflows', runtimeIdentity, 'execution', executionId]",
    ...workflowLive,
    sources: ['lib/workspace/workflow/queries.ts:258-272'],
  },
  workflowCheckpointList: {
    queryKey: "['workflows', runtimeIdentity, 'checkpoints', runId]",
    ...workflowLive,
    sources: ['lib/workspace/workflow/queries.ts:275-303'],
  },
  workflowCheckpoint: {
    queryKey: "['workflows', runtimeIdentity, 'checkpoint', checkpointId]",
    ...workflowLive,
    sources: ['lib/workspace/workflow/queries.ts:306-320'],
  },
  workflowCheckpointFile: {
    queryKey: "['workflows', runtimeIdentity, 'checkpoint-file', checkpointId, path]",
    ...workflowLive,
    sources: ['lib/workspace/workflow/queries.ts:329-348'],
    notes: 'Disabled unless the caller enables it (default enabled: false, line 337).',
  },
  controlPlane: {
    queryKey: "['control-plane']",
    ...defaults,
    refetchInterval: {
      everyMs: 1_000,
      while:
        "the last snapshot's startup gate is inventory_pending, or editor_provisioning in a transient state (checking, downloading, verifying, extracting)",
    },
    sources: [
      'lib/control-plane/queries.ts:20-42',
      'lib/control-plane/queries.ts:34-40 refetchInterval',
      'lib/control-plane/launchability.ts:50-69 deriveStartupGate, isTransientProvisioning',
    ],
    notes:
      'Disabled while the desktop host gate is connecting or failed (routes/startup/StartupGate.tsx:40).',
  },
  editorDiagnostics: {
    queryKey: "['editor', editorContextId, 'diagnostics', ptyProcessId]",
    ...defaults,
    staleTime: INFINITY,
    sources: ['lib/editor/queries.ts:63-95', 'lib/editor/queries.ts:87 staleTime'],
    notes: 'Its queryFn ignores the abort signal (lib/editor/queries.ts:88-93).',
  },
  clientSettings: {
    queryKey: "['client-settings']",
    ...defaults,
    staleTime: INFINITY,
    gcTime: INFINITY,
    sources: ['lib/client-settings/queries.ts:9-24', 'lib/client-settings/queries.ts:17-18'],
  },
  terminalSessionInventory: {
    queryKey: "['terminal', 'durable-session-inventory', generation]",
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    sources: [
      'lib/workspace/terminal-presentation/coordinator.ts:64-75',
      'query-core queryClient.js:181-185 fetchQuery retry',
    ],
    notes:
      'fetchQuery only, a fresh key per request generation and no observer, so focus/reconnect never re-read it; the coordinator re-reads it on runtime_connected and durable_inventory_refresh_requested (coordinator.ts:124).',
  },
} as const satisfies Readonly<Record<string, V3QueryPolicy>>;

export type V3QueryFamily = keyof typeof v3PolicyBaseline;
