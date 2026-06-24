import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Context, Effect, Layer } from 'effect';

import type {
  WorkflowAgentHarness,
  WorkflowHeadlessLaunch,
  WorkflowHeadlessPromptInput,
  WorkflowHeadlessResult,
  WorkflowWaitCondition,
} from '@isagi/workflow-sdk';

import { HarnessAdapterRegistry } from '../agent-sessions/harness/index.js';
import type { HarnessAdapterError } from '../agent-sessions/index.js';
import { PtyService } from '../pty-processes/index.js';
import type { PtyLaunchError } from '../pty-processes/pty.service.js';
import { InternalRuntimeEventBus } from '../runtime-events/index.js';

export const defaultHeadlessTimeoutMs = 10 * 60_000;
const timeoutTerminationGraceMs = 1_000;

export interface WorkflowHeadlessService {
  readonly runHeadlessPrompt: (input: {
    readonly runId: number;
    readonly worktreePath: string;
    readonly prompt: WorkflowHeadlessPromptInput;
  }) => Effect.Effect<
    { readonly opId: string; readonly launch: WorkflowHeadlessLaunch },
    PtyLaunchError | HarnessAdapterError
  >;
  readonly reissue: (input: {
    readonly runId: number;
    readonly worktreePath: string;
    readonly ops: readonly WorkflowHeadlessWaitOp[];
  }) => Effect.Effect<void, PtyLaunchError | HarnessAdapterError>;
  readonly completedResults: (
    condition: Extract<WorkflowWaitCondition, { readonly kind: 'headless' }>,
  ) => Effect.Effect<readonly WorkflowHeadlessResult[] | null>;
  readonly releaseOps: (input: {
    readonly opIds: readonly string[];
  }) => Effect.Effect<void>;
}

export type WorkflowHeadlessWaitOp = Extract<
  WorkflowWaitCondition,
  { readonly kind: 'headless' }
>['ops'][number];

type LiveHeadlessOp = {
  readonly runId: number;
  readonly opId: string;
  readonly launch: WorkflowHeadlessLaunch;
  readonly ptyProcessId: number;
  timeout: ReturnType<typeof setTimeout> | null;
};

type TrackedHeadlessOp =
  | LiveHeadlessOp
  | {
      readonly runId: number;
      readonly opId: string;
      readonly launch: WorkflowHeadlessLaunch;
      readonly result: WorkflowHeadlessResult;
    };

type CapturedHeadlessOutput = {
  readonly raw: string;
  readonly output: string;
};

export const WorkflowHeadless =
  Context.GenericTag<WorkflowHeadlessService>('isagi/WorkflowHeadless');

export const WorkflowHeadlessLive = Layer.scoped(
  WorkflowHeadless,
  Effect.gen(function* () {
    const harnesses = yield* HarnessAdapterRegistry;
    const pty = yield* PtyService;
    const eventBus = yield* InternalRuntimeEventBus;
    const byOpId = new Map<string, TrackedHeadlessOp>();
    const opIdByPtyProcessId = new Map<number, string>();

    const completeOp = (input: {
      readonly opId: string;
      readonly result: WorkflowHeadlessResult;
    }) =>
      Effect.gen(function* () {
        const tracked = byOpId.get(input.opId);
        if (!tracked || 'result' in tracked) return;
        if (tracked.timeout) clearTimeout(tracked.timeout);
        opIdByPtyProcessId.delete(tracked.ptyProcessId);
        yield* pty.unpin({ ptyProcessId: tracked.ptyProcessId });
        byOpId.set(input.opId, {
          runId: tracked.runId,
          opId: tracked.opId,
          launch: tracked.launch,
          result: input.result,
        });
        yield* eventBus.publish({
          type: 'headless_op_completed',
          runId: tracked.runId,
          opId: tracked.opId,
        });
      });

    const launchOp = (input: {
      readonly runId: number;
      readonly opId: string;
      readonly worktreePath: string;
      readonly launch: WorkflowHeadlessLaunch;
    }) =>
      Effect.gen(function* () {
        const existing = byOpId.get(input.opId);
        if (existing && !('result' in existing)) return;
        const launchInput = yield* harnesses.buildHeadlessLaunch({
          harness: input.launch.harness,
          cwd: input.worktreePath,
          prompt: input.launch.prompt,
          model: input.launch.model,
          effort: input.launch.effort,
        });
        const metadata = yield* pty.launch(launchInput);
        yield* pty.pin({ ptyProcessId: metadata.ptyProcessId });
        const timeout = setTimeout(() => {
          void Effect.runPromise(
            timeoutOp({
              opId: input.opId,
              ptyProcessId: metadata.ptyProcessId,
            }).pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  console.warn('[runtime] Headless workflow timeout handling failed', error);
                }),
              ),
            ),
          );
        }, input.launch.timeoutMs);
        timeout.unref();
        byOpId.set(input.opId, {
          runId: input.runId,
          opId: input.opId,
          launch: input.launch,
          ptyProcessId: metadata.ptyProcessId,
          timeout,
        });
        opIdByPtyProcessId.set(metadata.ptyProcessId, input.opId);
      });

    const timeoutOp = (input: { readonly opId: string; readonly ptyProcessId: number }) =>
      Effect.gen(function* () {
        const tracked = byOpId.get(input.opId);
        if (!tracked || 'result' in tracked) return;
        const captured = yield* outputForPty(pty, tracked.launch.harness, input.ptyProcessId).pipe(
          Effect.orElseSucceed(() => ({ raw: '', output: '' })),
        );
        yield* completeOp({
          opId: input.opId,
          result: {
            opId: input.opId,
            status: 'failed',
            error: 'timeout',
            exitCode: null,
            output: captured.output,
          },
        });
        yield* pty
          .terminate({
            ptyProcessId: input.ptyProcessId,
            gracefulTimeoutMs: timeoutTerminationGraceMs,
          })
          .pipe(Effect.ignore);
      });

    // Fully drop a single tracked op and free its resources. A live op's PTY is
    // terminated and unpinned; a completed op only needs its retained result
    // entry dropped (its PTY was already torn down on completion).
    const releaseOp = (opId: string) =>
      Effect.gen(function* () {
        const tracked = byOpId.get(opId);
        if (!tracked) return;
        byOpId.delete(opId);
        if ('result' in tracked) return;
        if (tracked.timeout) clearTimeout(tracked.timeout);
        opIdByPtyProcessId.delete(tracked.ptyProcessId);
        yield* pty.unpin({ ptyProcessId: tracked.ptyProcessId });
        yield* pty
          .terminate({
            ptyProcessId: tracked.ptyProcessId,
            gracefulTimeoutMs: timeoutTerminationGraceMs,
          })
          .pipe(Effect.ignore);
      });

    // Cancel every op still tracked for a run. Invoked when a run reaches a
    // terminal state so an orphaned or in-flight headless PTY cannot keep running
    // (and mutating the worktree) after its owning run is already dead.
    const cancelRunOps = (runId: number) =>
      Effect.gen(function* () {
        const opIds = [...byOpId.values()]
          .filter((tracked) => tracked.runId === runId)
          .map((tracked) => tracked.opId);
        for (const opId of opIds) yield* releaseOp(opId);
      });

    const subscription = yield* eventBus.subscribe({
      types: [
        'pty_process_exited',
        'pty_process_failed',
        'pty_process_killed',
        'workflow_run_terminal',
      ],
    });
    yield* Effect.addFinalizer(() => subscription.unsubscribe);
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* subscription.take;
          if (event.type === 'workflow_run_terminal') {
            yield* cancelRunOps(event.runId);
            return;
          }
          if (
            event.type !== 'pty_process_exited' &&
            event.type !== 'pty_process_failed' &&
            event.type !== 'pty_process_killed'
          ) {
            return;
          }
          const opId = opIdByPtyProcessId.get(event.ptyProcessId);
          if (!opId) return;
          const tracked = byOpId.get(opId);
          if (!tracked || 'result' in tracked) return;
          const captured = yield* outputForPty(
            pty,
            tracked.launch.harness,
            event.ptyProcessId,
          ).pipe(
            Effect.orElseSucceed(() => ({
              raw: '',
              output: '',
            })),
          );
          const semanticError = semanticErrorForHeadlessOutput(
            tracked.launch.harness,
            captured.raw,
          );
          const exitCode = event.type === 'pty_process_exited' ? event.exitCode : null;
          const status =
            event.type === 'pty_process_exited' && exitCode === 0 && semanticError === null
              ? 'completed'
              : 'failed';
          yield* completeOp({
            opId,
            result: {
              opId,
              status,
              output: captured.output,
              ...(status === 'failed'
                ? {
                    error:
                      semanticError ??
                      (event.type === 'pty_process_killed'
                        ? 'killed'
                        : event.type === 'pty_process_failed'
                          ? 'process_failed'
                          : 'non_zero_exit'),
                    exitCode,
                  }
                : { exitCode }),
            },
          });
        }).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.warn('[runtime] Headless workflow PTY event handling failed', error);
            }),
          ),
        ),
      ),
    );

    const service = {
      runHeadlessPrompt: (input) =>
        Effect.gen(function* () {
          const launch = normalizeHeadlessLaunch(input.prompt);
          const opId = `headless:${randomUUID()}`;
          yield* launchOp({
            runId: input.runId,
            opId,
            worktreePath: input.worktreePath,
            launch,
          });
          return { opId, launch };
        }),
      reissue: (input) =>
        Effect.gen(function* () {
          for (const op of input.ops) {
            // Skip any op we still track, whether it is live or already holds a
            // result; only launch ops absent from this runtime's tracker.
            if (byOpId.has(op.opId)) continue;
            yield* launchOp({
              runId: input.runId,
              opId: op.opId,
              worktreePath: input.worktreePath,
              launch: op.launch,
            });
          }
        }),
      completedResults: (condition) =>
        Effect.sync(() => {
          const results: WorkflowHeadlessResult[] = [];
          for (const op of condition.ops) {
            const tracked = byOpId.get(op.opId);
            if (!tracked || !('result' in tracked)) return null;
            results.push(tracked.result);
          }
          return results;
        }),
      // Drop tracker entries for ops whose results the reducer has consumed. The
      // persisted resume payload carries the results forward, so retaining the
      // captured output here would only grow the map unboundedly across a long
      // run's repeated headless judgments.
      releaseOps: (input) =>
        Effect.gen(function* () {
          for (const opId of input.opIds) yield* releaseOp(opId);
        }),
    } satisfies WorkflowHeadlessService;

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.sync(() => {
        for (const tracked of byOpId.values()) {
          if ('result' in tracked) continue;
          if (tracked.timeout) clearTimeout(tracked.timeout);
        }
        byOpId.clear();
        opIdByPtyProcessId.clear();
      }),
    );
  }),
);

export function normalizeHeadlessLaunch(
  input: WorkflowHeadlessPromptInput,
): WorkflowHeadlessLaunch {
  return {
    prompt: input.prompt,
    harness: input.harness,
    model: input.model,
    effort: input.effort,
    timeoutMs: input.timeoutMs ?? defaultHeadlessTimeoutMs,
  };
}

function outputForPty(
  pty: import('../pty-processes/index.js').PtyServiceShape,
  harness: WorkflowAgentHarness,
  ptyProcessId: number,
): Effect.Effect<CapturedHeadlessOutput, unknown> {
  return Effect.gen(function* () {
    const plan = yield* pty.getAttachmentPlan({ ptyProcessId });
    const raw = plan.session.logPath ? readFileSync(plan.session.logPath, 'utf8') : '';
    return {
      raw,
      output: extractHeadlessOutput(harness, raw),
    };
  });
}

export function extractHeadlessOutput(harness: WorkflowAgentHarness, raw: string): string {
  const clean = stripAnsi(raw);
  if (harness === 'claude') return extractClaudeOutput(clean);
  if (harness === 'pi') return extractPiOutput(clean);
  if (harness === 'opencode') return extractOpenCodeOutput(clean);
  if (harness === 'codex') return extractCodexOutput(clean);
  return clean.trim();
}

export function semanticErrorForHeadlessOutput(
  harness: WorkflowAgentHarness,
  raw: string,
): string | null {
  if (harness !== 'pi') return null;
  const records = parseJsonLines(stripAnsi(raw));
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const stopReason =
      stringAt(records[index], ['event', 'message', 'stopReason']) ??
      stringAt(records[index], ['message', 'stopReason']) ??
      stringAt(records[index], ['stopReason']);
    if (stopReason === 'error' || stopReason === 'aborted') return stopReason;
  }
  return null;
}

function extractClaudeOutput(raw: string) {
  const trimmed = raw.trim();
  const parsed = parseJson(trimmed) ?? parseFirstJsonValue(trimmed);
  if (Array.isArray(parsed)) {
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      const result = stringAt(parsed[index], ['result']);
      if (result) return result.trim();
    }
  }
  const result = stringAt(parsed, ['result']);
  if (result) return result.trim();
  return trimmed;
}

function extractCodexOutput(raw: string) {
  const records = parseJsonLines(raw);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const text =
      stringAt(record, ['last_assistant_message']) ??
      stringAt(record, ['lastAssistantMessage']) ??
      stringAt(record, ['item', 'text']) ??
      stringAt(record, ['item', 'content', 0, 'text']) ??
      stringAt(record, ['message', 'content', 0, 'text']) ??
      stringAt(record, ['output_text']) ??
      stringAt(record, ['text']);
    if (text) return text.trim();
  }
  return raw.trim();
}

function extractPiOutput(raw: string) {
  const records = parseJsonLines(raw);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const messages = arrayAt(record, ['messages']) ?? arrayAt(record, ['event', 'messages']);
    const fromMessages = textFromLastAssistantMessage(messages);
    if (fromMessages) return fromMessages.trim();
    const fromMessage = textFromMessage(
      objectAt(record, ['message']) ?? objectAt(record, ['event', 'message']),
    );
    if (fromMessage) return fromMessage.trim();
  }
  return raw.trim();
}

function extractOpenCodeOutput(raw: string) {
  const records = parseJsonLines(raw);
  const textByMessage = new Map<string, string[]>();
  const completedMessageIds: string[] = [];
  for (const record of records) {
    const part =
      objectAt(record, ['event', 'properties', 'part']) ??
      objectAt(record, ['properties', 'part']) ??
      objectAt(record, ['part']);
    const messageId = stringAt(part, ['messageID']) ?? stringAt(part, ['messageId']);
    const text = stringAt(part, ['text']);
    if (messageId && text) {
      const existing = textByMessage.get(messageId) ?? [];
      existing.push(text);
      textByMessage.set(messageId, existing);
    }
    const info =
      objectAt(record, ['event', 'properties', 'info']) ??
      objectAt(record, ['properties', 'info']) ??
      objectAt(record, ['info']);
    const id = stringAt(info, ['id']);
    const role = stringAt(info, ['role']);
    if (id && role === 'assistant') completedMessageIds.push(id);
    const direct = stringAt(record, ['text']) ?? stringAt(record, ['message', 'text']);
    if (direct) {
      textByMessage.set('__direct__', [direct]);
      completedMessageIds.push('__direct__');
    }
  }
  const lastId = completedMessageIds.at(-1);
  if (lastId) return (textByMessage.get(lastId) ?? []).join('').trim();
  return raw.trim();
}

function textFromLastAssistantMessage(messages: readonly unknown[] | null) {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = objectAt(messages[index], []);
    if (stringAt(message, ['role']) !== 'assistant') continue;
    const text = textFromMessage(message);
    if (text) return text;
  }
  return null;
}

function textFromMessage(message: Record<string, unknown> | null) {
  if (!message) return null;
  const content = unknownAt(message, ['content']);
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((part) => {
        const text = stringAt(part, ['text']);
        return text ? [text] : [];
      })
      .join('');
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseFirstJsonValue(value: string): unknown {
  const start = value.search(/[[{]/);
  if (start === -1) return null;
  const opening = value[start];
  const closing = opening === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === opening) depth += 1;
    if (char === closing) depth -= 1;
    if (depth === 0) return parseJson(value.slice(start, index + 1));
  }
  return null;
}

function parseJsonLines(value: string): unknown[] {
  return value.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return [];
    const parsed = parseJson(trimmed);
    return parsed === null ? [] : [parsed];
  });
}

function stringAt(value: unknown, path: readonly (string | number)[]): string | null {
  const found = unknownAt(value, path);
  return typeof found === 'string' ? found : null;
}

function objectAt(
  value: unknown,
  path: readonly (string | number)[],
): Record<string, unknown> | null {
  const found = unknownAt(value, path);
  return found && typeof found === 'object' && !Array.isArray(found)
    ? (found as Record<string, unknown>)
    : null;
}

function arrayAt(value: unknown, path: readonly (string | number)[]): readonly unknown[] | null {
  const found = unknownAt(value, path);
  return Array.isArray(found) ? found : null;
}

function unknownAt(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stripAnsi(value: string) {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    '',
  );
}
