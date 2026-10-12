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
  const seenPrompts = new Set<string>();
  const activePrompts = new Set<string>();

  for (const record of records) {
    if (record.harness !== 'claude') continue;
    const payload = object(record.event);
    const promptKey =
      typeof payload.prompt_id === 'string' && payload.prompt_id
        ? `${record.ptyProcessId}:${payload.prompt_id}`
        : null;
    if (record.nativeEvent === 'UserPromptSubmit') {
      if (promptKey && seenPrompts.has(promptKey)) continue;
      const replacedProcess =
        activeTurn &&
        activeTurn.ptyProcessId !== null &&
        record.ptyProcessId !== null &&
        activeTurn.ptyProcessId !== record.ptyProcessId;
      // Background results are submitted as prompts inside the same logical
      // turn. A distinct user prompt supersedes interrupted work: Claude does
      // not emit Stop for user interrupts. UserPromptSubmit is still a start
      // on older Claude versions without prompt_id; IDs add correlation and
      // deduplication, not the authority to start a turn.
      const backgroundResult =
        typeof payload.prompt === 'string' &&
        payload.prompt.trimStart().startsWith('<task-notification>');
      if (activeTurn && (replacedProcess || !backgroundResult)) {
        terminalEdges.push({
          type: 'turn_failed',
          harnessSessionId: '',
          seq: activeTurn.seq,
          // Match the observer's session_died edge so replay and live polling
          // retain the same failure identity across a process replacement.
          recordedAt: replacedProcess ? activeTurn.recordedAt : record.recordedAt,
          reason: replacedProcess ? 'session_died' : 'new_start_supersedes',
        });
        activeTurn = null;
      }
      if (!activeTurn) {
        pendingQuestions.clear();
        completedQuestions.clear();
        activePrompts.clear();
        activeTurn = start(record);
      }
      if (promptKey) {
        seenPrompts.add(promptKey);
        activePrompts.add(promptKey);
      }
      attention = pendingQuestions.size > 0 ? 'waiting' : 'working';
      continue;
    }
    // Late question/Stop hooks from superseded prompts must not change the
    // current turn. Continuation prompts remain members of that same turn.
    if (promptKey && activePrompts.size > 0 && !activePrompts.has(promptKey)) continue;
    if (isQuestionHookEvent(record.nativeEvent)) {
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
      // Monitors (for example artifact live updates) stay registered while
      // Claude is waiting. Only these known passive tasks are excluded; unknown
      // task types still conservatively count as outstanding work.
      if (
        parsed.backgroundTasks === null ||
        parsed.backgroundTasks.some((task) => object(task).type !== 'monitor')
      )
        continue;
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
