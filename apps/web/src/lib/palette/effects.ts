import type { Dispatch } from 'react';

import { paletteCopy } from '../../copy/index.js';
import { runRuntimeEffect } from '../runtime/run.js';
import { formatRuntimeErrorSummary, suggestProjectPaths } from '../workspace/runtime-data.js';
import { workbenchActionCommands } from './commands/workbench-actions.js';
import { resolveCommandPreflight } from './dispatcher.js';
import type { PaletteEffect, PaletteEvent, PaletteState } from './machine.js';
import type { PaletteCommand, PaletteContext, PaletteEntry } from './types.js';

export function runPaletteEffects(
  effects: readonly PaletteEffect[],
  options: {
    readonly allEntries: readonly PaletteEntry[];
    readonly ctx: PaletteContext;
    readonly send: Dispatch<PaletteEvent>;
    readonly pushRecent: (entryId: string) => void;
    readonly pathSuggestTimer: { current: number | null };
    readonly seenEffectIds: { current: Set<number> };
  },
) {
  const pending = effects.filter((effect) => !options.seenEffectIds.current.has(effect.id));
  if (pending.length === 0) {
    return;
  }

  for (const effect of pending) {
    options.seenEffectIds.current.add(effect.id);
  }
  options.send({ type: 'effects-consumed', ids: pending.map((effect) => effect.id) });

  for (const effect of pending) {
    runPaletteEffect(effect, options);
  }
}

function runPaletteEffect(
  effect: PaletteEffect,
  options: {
    readonly allEntries: readonly PaletteEntry[];
    readonly ctx: PaletteContext;
    readonly send: Dispatch<PaletteEvent>;
    readonly pushRecent: (entryId: string) => void;
    readonly pathSuggestTimer: { current: number | null };
  },
) {
  if (effect.kind === 'preflight') {
    const command = resolveCommandByIds(options.allEntries, effect.entryId, effect.commandId);
    if (!command) {
      options.send({
        type: 'preflight-failed',
        attemptId: effect.attemptId,
        error: paletteCopy.outcome.commandUnavailableTitle,
      });
      return;
    }
    void resolveMaybe(() => resolveCommandPreflight(command, options.ctx, effect.values)).then(
      (result) =>
        options.send({
          type: 'preflight-succeeded',
          attemptId: effect.attemptId,
          entryId: effect.entryId,
          command,
          ctx: options.ctx,
          result,
        }),
      (error: unknown) =>
        options.send({
          type: 'preflight-failed',
          attemptId: effect.attemptId,
          error: formatRuntimeErrorSummary(error),
        }),
    );
    return;
  }

  if (effect.kind === 'loadOptions') {
    const command = resolveCommandByIds(options.allEntries, effect.entryId, effect.commandId);
    const spec = command?.args?.[effect.stepIndex];
    if (!spec || (spec.kind !== 'select' && spec.kind !== 'combo')) {
      options.send({
        type: 'options-failed',
        attemptId: effect.attemptId,
        error: paletteCopy.outcome.commandUnavailableTitle,
      });
      return;
    }
    void resolveMaybe(() => spec.options(options.ctx, effect.values)).then(
      (loaded) =>
        options.send({ type: 'options-loaded', attemptId: effect.attemptId, options: loaded }),
      (error: unknown) =>
        options.send({
          type: 'options-failed',
          attemptId: effect.attemptId,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return;
  }

  if (effect.kind === 'loadReview') {
    const command = resolveCommandByIds(options.allEntries, effect.entryId, effect.commandId);
    const spec = command?.args?.[effect.stepIndex];
    if (!spec || spec.kind !== 'review') {
      options.send({
        type: 'review-failed',
        attemptId: effect.attemptId,
        error: paletteCopy.outcome.commandUnavailableTitle,
      });
      return;
    }
    void resolveMaybe(() => spec.load(options.ctx, effect.values)).then(
      (content) =>
        options.send({
          type: 'review-loaded',
          attemptId: effect.attemptId,
          command,
          ctx: options.ctx,
          content,
        }),
      (error: unknown) =>
        options.send({
          type: 'review-failed',
          attemptId: effect.attemptId,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return;
  }

  if (effect.kind === 'suggestPaths') {
    if (options.pathSuggestTimer.current !== null) {
      window.clearTimeout(options.pathSuggestTimer.current);
    }
    options.pathSuggestTimer.current = window.setTimeout(() => {
      options.pathSuggestTimer.current = null;
      void runRuntimeEffect(suggestProjectPaths(effect.query)).then(
        (output) =>
          options.send({
            type: 'paths-loaded',
            attemptId: effect.attemptId,
            suggestions: output.suggestions,
          }),
        (error: unknown) =>
          options.send({
            type: 'paths-failed',
            attemptId: effect.attemptId,
            error: formatRuntimeErrorSummary(error),
          }),
      );
    }, 80);
    return;
  }

  const entry = options.allEntries.find((candidate) => candidate.id === effect.entryId);
  const command = effect.commandId
    ? resolveCommandByIds(options.allEntries, effect.entryId, effect.commandId)
    : null;
  const run = command
    ? () => command.run(effect.values, options.ctx, effect.payloads)
    : entry
      ? () => entry.run()
      : null;

  if (!run) {
    options.send({
      type: 'run-failed',
      attemptId: effect.attemptId,
      error: paletteCopy.outcome.commandUnavailableTitle,
    });
    return;
  }

  void resolveMaybe(run).then(
    (outcome) => {
      options.pushRecent(effect.entryId);
      options.send({ type: 'run-succeeded', attemptId: effect.attemptId, outcome });
    },
    (error: unknown) =>
      options.send({
        type: 'run-failed',
        attemptId: effect.attemptId,
        error: formatRuntimeErrorSummary(error),
      }),
  );
}

function resolveMaybe<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }
}

export function resolveStateCommand(
  state: PaletteState,
  entries: readonly PaletteEntry[],
): PaletteCommand | null {
  if (state.kind !== 'step') {
    return null;
  }
  return resolveCommandByIds(entries, state.flow.entryId, state.flow.commandId);
}

function resolveCommandByIds(
  entries: readonly PaletteEntry[],
  entryId: string,
  commandId: string,
): PaletteCommand | null {
  return (
    entries.find((entry) => entry.id === entryId && entry.command?.id === commandId)?.command ??
    workbenchActionCommands.find((command) => command.id === entryId && command.id === commandId) ??
    null
  );
}

export function commandForWorkbenchActionId(entryId: string | null): {
  readonly entryId: string;
  readonly command: PaletteCommand;
  readonly values?: PaletteEntry['values'];
} | null {
  if (!entryId) {
    return null;
  }
  const command = workbenchActionCommands.find((candidate) => candidate.id === entryId);
  return command ? { entryId, command } : null;
}
