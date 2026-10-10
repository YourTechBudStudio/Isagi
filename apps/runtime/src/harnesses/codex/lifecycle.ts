import type {
  ActiveHarnessTurn,
  HarnessLifecycleDiagnostic,
  HarnessLifecycleResult,
} from '../lifecycle.js';
import type { CodexRolloutEntry } from './native-artifacts.js';

export interface CodexRolloutLifecycleRecord {
  readonly seq: number;
  readonly recordedAt: string;
  readonly ptyProcessId: number | null;
  readonly entry: CodexRolloutEntry;
}

export function reduceCodexRolloutLifecycle(
  records: readonly CodexRolloutLifecycleRecord[],
): HarnessLifecycleResult {
  const state: { activeTurn: (ActiveHarnessTurn & { readonly turnId: string }) | null } = {
    activeTurn: null,
  };
  let attention: HarnessLifecycleResult['attention'] = 'idle';
  const terminalEdges: HarnessLifecycleResult['terminalEdges'][number][] = [];
  const diagnostics: HarnessLifecycleDiagnostic[] = [];

  for (const record of records) {
    const payload = eventMessage(record.entry);
    if (!payload) continue;
    const type = payload.type;
    if (type !== 'task_started' && type !== 'task_complete' && type !== 'turn_aborted') continue;
    if (!record.recordedAt) {
      diagnostics.push({ code: 'unsupported_native_shape', recordedAt: '' });
      continue;
    }
    const turnId = typeof payload.turn_id === 'string' && payload.turn_id ? payload.turn_id : null;
    if (!turnId) {
      diagnostics.push({ code: 'missing_native_turn_id', recordedAt: record.recordedAt });
      continue;
    }
    if (type === 'task_started') {
      if (state.activeTurn?.turnId === turnId) continue;
      if (state.activeTurn) {
        terminalEdges.push({
          type: 'turn_failed',
          harnessSessionId: '',
          seq: state.activeTurn.seq,
          recordedAt: record.recordedAt,
          reason: 'new_start_supersedes',
        });
      }
      state.activeTurn = {
        seq: record.seq,
        recordedAt: record.recordedAt,
        ptyProcessId: record.ptyProcessId,
        turnId,
      };
      attention = 'working';
      continue;
    }
    if (!state.activeTurn || state.activeTurn.turnId !== turnId) {
      diagnostics.push({ code: 'unknown_native_turn', recordedAt: record.recordedAt });
      continue;
    }
    if (type === 'task_complete') {
      terminalEdges.push({
        type: 'turn_ended',
        harnessSessionId: '',
        seq: state.activeTurn.seq,
        recordedAt: record.recordedAt,
      });
      attention = 'waiting';
    } else {
      terminalEdges.push({
        type: 'turn_failed',
        harnessSessionId: '',
        seq: state.activeTurn.seq,
        recordedAt: record.recordedAt,
        reason: 'harness_error',
      });
      const reason = typeof payload.reason === 'string' ? payload.reason : null;
      diagnostics.push(
        reason
          ? { code: 'native_turn_aborted', recordedAt: record.recordedAt, detail: reason }
          : { code: 'native_turn_aborted', recordedAt: record.recordedAt },
      );
      attention = 'error';
    }
    state.activeTurn = null;
  }
  return { activeTurn: state.activeTurn, terminalEdges, attention, diagnostics };
}

function eventMessage(entry: CodexRolloutEntry): Record<string, unknown> | null {
  if (entry.type !== 'event_msg') return null;
  const payload = entry.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}
