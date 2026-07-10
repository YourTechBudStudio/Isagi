import type { HarnessLifecycleDiagnostic, HarnessLifecycleResult } from '../lifecycle.js';
import type { HarnessObservationRecord } from '../projection.js';

export function reduceOpenCodeLifecycle(
  records: readonly HarnessObservationRecord[],
): HarnessLifecycleResult {
  let activeTurn: HarnessLifecycleResult['activeTurn'] = null;
  let attention: HarnessLifecycleResult['attention'] = 'idle';
  const terminalEdges: HarnessLifecycleResult['terminalEdges'][number][] = [];
  const diagnostics: HarnessLifecycleDiagnostic[] = [];
  const pendingQuestions = new Set<string>();
  const completedQuestions = new Set<string>();

  for (const record of orderedLifecycleRecords(records, diagnostics)) {
    if (record.nativeEvent === 'session.error') {
      // Native errors are useful diagnostics, but OpenCode's terminal fence is
      // root status idle. Do not turn a recoverable error into a false failure.
      diagnostics.push({ code: 'native_session_error', recordedAt: record.recordedAt });
      continue;
    }
    if (record.nativeEvent === 'question.asked') {
      if (!activeTurn) continue;
      const requestId = questionRequestId(record.event, 'asked');
      if (!requestId) {
        diagnostics.push({
          code: 'malformed_optional_field',
          recordedAt: record.recordedAt,
          detail: 'question.asked.properties.id',
        });
        continue;
      }
      if (completedQuestions.has(requestId)) continue;
      pendingQuestions.add(requestId);
      attention = 'waiting';
      continue;
    }
    if (record.nativeEvent === 'question.replied' || record.nativeEvent === 'question.rejected') {
      if (!activeTurn) continue;
      const requestId = questionRequestId(record.event, 'completed');
      if (!requestId) {
        diagnostics.push({
          code: 'malformed_optional_field',
          recordedAt: record.recordedAt,
          detail: `${record.nativeEvent}.properties.requestID`,
        });
        continue;
      }
      if (completedQuestions.has(requestId)) continue;
      completedQuestions.add(requestId);
      if (!pendingQuestions.delete(requestId)) {
        diagnostics.push({
          code: 'unmatched_user_input_completion',
          recordedAt: record.recordedAt,
          detail: record.nativeEvent,
        });
        continue;
      }
      attention = pendingQuestions.size > 0 ? 'waiting' : 'working';
      continue;
    }
    if (record.nativeEvent !== 'session.status') continue;
    const status = statusFromEvent(record.event);
    if (!status) {
      diagnostics.push({ code: 'unknown_status_shape', recordedAt: record.recordedAt });
      continue;
    }
    if (status === 'busy') {
      if (!activeTurn) activeTurn = start(record);
      attention = pendingQuestions.size > 0 ? 'waiting' : 'working';
      continue;
    }
    if (status === 'retry') {
      if (activeTurn) attention = pendingQuestions.size > 0 ? 'waiting' : 'working';
      continue;
    }
    if (status === 'idle') {
      if (!activeTurn) continue;
      terminalEdges.push({
        type: 'turn_ended',
        harnessSessionId: '',
        seq: activeTurn.seq,
        recordedAt: record.recordedAt,
      });
      pendingQuestions.clear();
      activeTurn = null;
      attention = 'waiting';
      continue;
    }
    diagnostics.push({
      code: 'unknown_status_shape',
      recordedAt: record.recordedAt,
      detail: status,
    });
  }
  return { activeTurn, terminalEdges, attention, diagnostics };
}

function orderedLifecycleRecords(
  records: readonly HarnessObservationRecord[],
  diagnostics: HarnessLifecycleDiagnostic[],
) {
  const seenEventIds = new Set<string>();
  return records
    .filter((record) => record.harness === 'opencode' && isLifecycleEvent(record.nativeEvent))
    .flatMap((record) => {
      const eventId = nativeEventId(record.event);
      if (!eventId) {
        diagnostics.push({
          code: 'missing_native_event_id',
          recordedAt: record.recordedAt,
          detail: record.nativeEvent,
        });
        return [];
      }
      if (seenEventIds.has(eventId)) return [];
      seenEventIds.add(eventId);
      return [{ record, eventId }];
    })
    .sort((left, right) => compareStrings(left.eventId, right.eventId))
    .map(({ record }) => record);
}

function isLifecycleEvent(nativeEvent: string) {
  return (
    nativeEvent === 'session.status' ||
    nativeEvent === 'session.error' ||
    nativeEvent === 'question.asked' ||
    nativeEvent === 'question.replied' ||
    nativeEvent === 'question.rejected'
  );
}

function nativeEventId(value: unknown) {
  const id = object(value).id;
  return typeof id === 'string' && /^evt_[0-9a-f]{12}/.test(id) ? id : null;
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function questionRequestId(value: unknown, phase: 'asked' | 'completed') {
  const properties = object(object(value).properties);
  const requestId = phase === 'asked' ? properties.id : properties.requestID;
  return typeof requestId === 'string' && requestId ? requestId : null;
}

function start(record: HarnessObservationRecord) {
  return { seq: record.seq, recordedAt: record.recordedAt, ptyProcessId: record.ptyProcessId };
}

function statusFromEvent(value: unknown) {
  const event = object(value);
  const properties = object(event.properties);
  const session = object(properties.session);
  return statusValue(properties.status) ?? statusValue(session.status) ?? statusValue(event.status);
}

function statusValue(value: unknown) {
  if (typeof value === 'string' && value) return value;
  const objectValue = object(value);
  return typeof objectValue.type === 'string' && objectValue.type ? objectValue.type : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
