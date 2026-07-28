/**
 * Terminal diagnostics are retained in memory and printed in development, so they carry
 * shape and never content: counts, durations, numeric identifiers, and labels drawn from a
 * closed vocabulary this module owns.
 *
 * The vocabularies below are the whole contract. A label the collector does not recognize is
 * replaced with `unlabeled`, and an unrecognized gauge name is dropped — so a future producer
 * cannot pass a token, a path, or a word lifted out of session output through this surface,
 * whatever it happens to look like. Adding a diagnostic means adding it here, in the open,
 * which is the point.
 */

/** Every event a terminal producer may report. `*_duration` kinds also feed the histogram. */
export const terminalDiagnosticKinds = [
  // Presentation cache
  'operation_rejected',
  'resource_dispose_failed',
  'placement_displaced',
  'scope_mismatch',
  'presentation_evicted',
  'visible_only_overage',
  // Attachment controller
  'replay_duration',
  'reveal_duration',
  'webgl_context_loss',
  'socket_opened',
  'socket_closed',
  // Workspace coordinator
  'inventory_rejected',
  // Substituted for anything outside this vocabulary.
  'unlabeled',
] as const;

/**
 * Why an event happened. Every kind is also a valid reason, because most producers report a
 * kind with no finer cause and pass it through unchanged.
 */
export const terminalDiagnosticReasons = [
  ...terminalDiagnosticKinds,
  // Rejected cache mutations
  'stale',
  'sealed',
  'invalid_state',
  'placement_mismatch',
  'resource_dispose_threw',
  // Retention pressure
  'ttl',
  'hidden_count',
  'memory_budget',
  // Coordinator reconciliation
  'delete_event_scope_mismatch',
  'conflicting_duplicate_identity',
] as const;

/** Every named gauge. Anything else is dropped rather than retained under its own name. */
export const terminalDiagnosticGaugeNames = [
  // Cache occupancy
  'entryCount',
  'visibleLeases',
  'hiddenCount',
  'activeSockets',
  'estimatedBytes',
  // Terminal buffer shape
  'bufferType',
  'normalBufferRows',
  'alternateBufferRows',
  'terminalColumns',
  'viewportRow',
  'baseRow',
] as const;

export type TerminalDiagnosticKind = (typeof terminalDiagnosticKinds)[number];
export type TerminalDiagnosticReason = (typeof terminalDiagnosticReasons)[number];
export type TerminalDiagnosticGaugeName = (typeof terminalDiagnosticGaugeNames)[number];

export type TerminalDiagnosticGauges = Readonly<
  Partial<Record<TerminalDiagnosticGaugeName, number>>
>;

export interface TerminalDiagnosticEvent {
  readonly kind: TerminalDiagnosticKind;
  readonly reason: TerminalDiagnosticReason;
  readonly sessionKind?: 'agent_session' | 'terminal_session' | undefined;
  readonly sessionId?: number | undefined;
  readonly worktreeId?: number | undefined;
  readonly surfaceId?: number | undefined;
  readonly paneId?: number | undefined;
  readonly value?: number | undefined;
}

export interface TerminalDiagnosticsSnapshot {
  readonly totalEvents: number;
  readonly gauges: TerminalDiagnosticGauges;
  readonly counters: Readonly<Partial<Record<TerminalDiagnosticKind, number>>>;
  readonly durations: Readonly<
    Partial<
      Record<
        TerminalDiagnosticKind,
        {
          readonly count: number;
          readonly total: number;
          readonly min: number;
          readonly max: number;
        }
      >
    >
  >;
  readonly recent: readonly TerminalDiagnosticEvent[];
}

export interface TerminalDiagnosticsCollector {
  readonly record: (event: TerminalDiagnosticEvent) => void;
  readonly setGauges: (gauges: TerminalDiagnosticGauges) => void;
  readonly getSnapshot: () => TerminalDiagnosticsSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

const kinds: ReadonlySet<string> = new Set(terminalDiagnosticKinds);
const reasons: ReadonlySet<string> = new Set(terminalDiagnosticReasons);
const gaugeNames: ReadonlySet<string> = new Set(terminalDiagnosticGaugeNames);

const kind = (value: string): TerminalDiagnosticKind =>
  kinds.has(value) ? (value as TerminalDiagnosticKind) : 'unlabeled';

const reason = (value: string): TerminalDiagnosticReason =>
  reasons.has(value) ? (value as TerminalDiagnosticReason) : 'unlabeled';

const identifier = (value: number | undefined) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const measurement = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const sessionKind = (value: TerminalDiagnosticEvent['sessionKind']) =>
  value === 'agent_session' || value === 'terminal_session' ? value : undefined;

/**
 * Rebuilds the retained event field by field, from the vocabulary rather than from the
 * caller. Copying the caller's object — even a shallow copy, even with a shape check on the
 * strings — would retain whatever a future caller happened to attach to it, which is exactly
 * the leak this surface promises not to have.
 */
function sanitizeEvent(event: TerminalDiagnosticEvent): TerminalDiagnosticEvent {
  return Object.freeze({
    kind: kind(event.kind),
    reason: reason(event.reason),
    sessionKind: sessionKind(event.sessionKind),
    sessionId: identifier(event.sessionId),
    worktreeId: identifier(event.worktreeId),
    surfaceId: identifier(event.surfaceId),
    paneId: identifier(event.paneId),
    value: measurement(event.value),
  });
}

export function createTerminalDiagnosticsCollector(): TerminalDiagnosticsCollector {
  const listeners = new Set<() => void>();
  let snapshot: TerminalDiagnosticsSnapshot = Object.freeze({
    totalEvents: 0,
    gauges: Object.freeze({}),
    counters: Object.freeze({}),
    durations: Object.freeze({}),
    recent: Object.freeze([]),
  });
  return {
    record(input) {
      const event = sanitizeEvent(input);
      const counters = {
        ...snapshot.counters,
        [event.kind]: (snapshot.counters[event.kind] ?? 0) + 1,
      };
      const durations = { ...snapshot.durations };
      if (event.kind.endsWith('_duration') && event.value !== undefined) {
        const current = durations[event.kind];
        durations[event.kind] = current
          ? {
              count: current.count + 1,
              total: current.total + event.value,
              min: Math.min(current.min, event.value),
              max: Math.max(current.max, event.value),
            }
          : { count: 1, total: event.value, min: event.value, max: event.value };
      }
      snapshot = Object.freeze({
        totalEvents: snapshot.totalEvents + 1,
        gauges: snapshot.gauges,
        counters: Object.freeze(counters),
        durations: Object.freeze(durations),
        recent: Object.freeze([...snapshot.recent.slice(-63), event]),
      });
      if (import.meta.env?.DEV) console.debug('[terminal-diagnostics]', event);
      for (const listener of listeners) listener();
    },
    setGauges(gauges) {
      const accepted: Record<string, number> = {};
      for (const [name, value] of Object.entries(gauges)) {
        if (gaugeNames.has(name) && typeof value === 'number' && Number.isFinite(value)) {
          accepted[name] = value;
        }
      }
      snapshot = Object.freeze({
        ...snapshot,
        gauges: Object.freeze({ ...snapshot.gauges, ...accepted }),
      });
      for (const listener of listeners) listener();
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
