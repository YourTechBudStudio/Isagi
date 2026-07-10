import type { HarnessLifecycleDiagnostic, HarnessLifecycleResult } from '../lifecycle.js';
import type { HarnessObservationRecord } from '../projection.js';

export function reduceClaudeLifecycle(
  records: readonly HarnessObservationRecord[],
): HarnessLifecycleResult {
  let activeTurn: HarnessLifecycleResult['activeTurn'] = null;
  let attention: HarnessLifecycleResult['attention'] = 'idle';
  const terminalEdges: HarnessLifecycleResult['terminalEdges'][number][] = [];
  const diagnostics: HarnessLifecycleDiagnostic[] = [];
  const pendingQuestions = new Set<string>();
  const completedQuestions = new Set<string>();

  for (const record of records) {
    if (record.harness !== 'claude') continue;
    if (record.nativeEvent === 'UserPromptSubmit') {
      if (!activeTurn) {
        pendingQuestions.clear();
        completedQuestions.clear();
        activeTurn = start(record);
      }
      // Claude delivers completed background-agent results as another
      // UserPromptSubmit inside the same user-visible turn. Preserve the
      // original opening sequence until native Stop evidence says the whole
      // turn is terminal.
      attention = pendingQuestions.size > 0 ? 'waiting' : 'working';
      continue;
    }
    if (isQuestionHookEvent(record.nativeEvent)) {
      const payload = object(record.event);
      if (payload.tool_name !== 'AskUserQuestion' || !activeTurn) continue;
      const toolUseId = payload.tool_use_id;
      if (typeof toolUseId !== 'string' || !toolUseId) {
        diagnostics.push({
          code: 'malformed_optional_field',
          recordedAt: record.recordedAt,
          detail: `${record.nativeEvent}.tool_use_id`,
        });
        continue;
      }
      if (record.nativeEvent === 'PreToolUse') {
        if (completedQuestions.has(toolUseId)) continue;
        pendingQuestions.add(toolUseId);
        attention = 'waiting';
        continue;
      }
      if (completedQuestions.has(toolUseId)) continue;
      completedQuestions.add(toolUseId);
      if (!pendingQuestions.delete(toolUseId)) {
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
    if (record.nativeEvent === 'Stop') {
      const parsed = stopFields(record.event);
      if (parsed.malformed) {
        diagnostics.push({
          code: 'malformed_optional_field',
          recordedAt: record.recordedAt,
          detail: parsed.malformed,
        });
      }
      if (!activeTurn) continue;
      if (parsed.backgroundTasks === null || parsed.backgroundTasks.length > 0) continue;
      terminalEdges.push({
        type: 'turn_ended',
        harnessSessionId: '',
        seq: activeTurn.seq,
        recordedAt: record.recordedAt,
      });
      pendingQuestions.clear();
      completedQuestions.clear();
      activeTurn = null;
      attention = 'waiting';
      continue;
    }
    if (record.nativeEvent === 'StopFailure') {
      if (!activeTurn) continue;
      terminalEdges.push({
        type: 'turn_failed',
        harnessSessionId: '',
        seq: activeTurn.seq,
        recordedAt: record.recordedAt,
        reason: 'harness_error',
      });
      pendingQuestions.clear();
      completedQuestions.clear();
      activeTurn = null;
      attention = 'error';
      continue;
    }
  }
  return { activeTurn, terminalEdges, attention, diagnostics };
}

function isQuestionHookEvent(nativeEvent: string) {
  return (
    nativeEvent === 'PreToolUse' ||
    nativeEvent === 'PostToolUse' ||
    nativeEvent === 'PostToolUseFailure'
  );
}

function start(record: HarnessObservationRecord) {
  return {
    seq: record.seq,
    recordedAt: record.recordedAt,
    ptyProcessId: record.ptyProcessId,
  };
}

function stopFields(value: unknown) {
  const payload = object(value);
  const backgroundTasks = payload.background_tasks;
  const malformed: string[] = [];
  if (!Array.isArray(backgroundTasks)) malformed.push('background_tasks');
  if ('session_crons' in payload && !Array.isArray(payload.session_crons))
    malformed.push('session_crons');
  if ('stop_hook_active' in payload && typeof payload.stop_hook_active !== 'boolean') {
    malformed.push('stop_hook_active');
  }
  return {
    backgroundTasks: Array.isArray(backgroundTasks) ? backgroundTasks : null,
    malformed: malformed.join(',') || null,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
