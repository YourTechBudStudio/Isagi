import { firstUnfilledStep, labelForValue, nextVisibleStep, prevVisibleStep } from './model.js';
import type {
  ArgPayloads,
  ArgSpec,
  ArgValues,
  CommandErrorContent,
  CommandOutcome,
  CommandResultContent,
  Option,
  PaletteCommand,
  PaletteContext,
  PaletteEntry,
  ReviewChoice,
  ReviewContent,
} from './types.js';

export type StepData =
  | {
      readonly kind: 'select' | 'combo';
      readonly options: readonly Option[];
      readonly loading: boolean;
      readonly error: string | null;
      readonly attemptId: number;
    }
  | {
      readonly kind: 'review';
      readonly content: ReviewContent | null;
      readonly loading: boolean;
      readonly error: string | null;
      readonly attemptId: number;
    }
  | {
      readonly kind: 'path';
      readonly suggestions: readonly PathSuggestionLike[];
      readonly suggestionsQuery: string;
      readonly loading: boolean;
      readonly error: string | null;
      readonly attemptId: number;
    }
  | {
      readonly kind: 'text';
    };

export interface PathSuggestionLike {
  readonly label: string;
  readonly path: string;
  readonly hidden?: boolean | undefined;
}

export interface PaletteFlow {
  readonly entryId: string;
  readonly commandId: string;
  readonly values: ArgValues;
  readonly payloads: ArgPayloads;
  readonly labels: Readonly<Record<string, string>>;
  readonly stepIndex: number;
}

export type PaletteEffect =
  | {
      readonly id: number;
      readonly kind: 'preflight';
      readonly attemptId: number;
      readonly entryId: string;
      readonly commandId: string;
      readonly values: ArgValues;
    }
  | {
      readonly id: number;
      readonly kind: 'run';
      readonly attemptId: number;
      readonly entryId: string;
      readonly commandId?: string | undefined;
      readonly values: ArgValues;
      readonly payloads: ArgPayloads;
    }
  | {
      readonly id: number;
      readonly kind: 'loadOptions';
      readonly attemptId: number;
      readonly entryId: string;
      readonly commandId: string;
      readonly stepIndex: number;
      readonly values: ArgValues;
    }
  | {
      readonly id: number;
      readonly kind: 'loadReview';
      readonly attemptId: number;
      readonly entryId: string;
      readonly commandId: string;
      readonly stepIndex: number;
      readonly values: ArgValues;
      readonly payloads: ArgPayloads;
    }
  | {
      readonly id: number;
      readonly kind: 'suggestPaths';
      readonly attemptId: number;
      readonly query: string;
    };

type PaletteEffectInput =
  | Omit<Extract<PaletteEffect, { kind: 'preflight' }>, 'id'>
  | Omit<Extract<PaletteEffect, { kind: 'run' }>, 'id'>
  | Omit<Extract<PaletteEffect, { kind: 'loadOptions' }>, 'id'>
  | Omit<Extract<PaletteEffect, { kind: 'loadReview' }>, 'id'>
  | Omit<Extract<PaletteEffect, { kind: 'suggestPaths' }>, 'id'>;

interface BaseState {
  readonly effects: readonly PaletteEffect[];
  readonly nextEffectId: number;
  readonly nextAttemptId: number;
}

type ClosedStateBody = {
  readonly kind: 'closed';
};

type SearchStateBody = {
  readonly kind: 'search';
  readonly query: string;
  readonly inlineError: string | null;
  readonly preflightAttemptId: number | null;
  readonly runAttemptId: number | null;
  readonly viewKey: string;
};

type StepStateBody = {
  readonly kind: 'step';
  readonly flow: PaletteFlow;
  readonly query: string;
  readonly stepData: StepData;
  readonly inlineError: string | null;
  readonly runAttemptId: number | null;
  readonly lastFilledPath: string | null;
  readonly viewKey: string;
};

type ResultStateBody = {
  readonly kind: 'result';
  readonly content: CommandResultContent;
  readonly entryId: string | null;
  readonly viewKey: string;
};

type ErrorStateBody = {
  readonly kind: 'error';
  readonly content: CommandErrorContent;
  readonly entryId: string | null;
  readonly viewKey: string;
};

type PaletteStateBody =
  | ClosedStateBody
  | SearchStateBody
  | StepStateBody
  | ResultStateBody
  | ErrorStateBody;

export type PaletteState = BaseState & PaletteStateBody;

export type PaletteEvent =
  | { readonly type: 'closed' }
  | { readonly type: 'opened' }
  | {
      readonly type: 'autostart';
      readonly entryId: string;
      readonly command: PaletteCommand;
      readonly ctx: PaletteContext;
      readonly values: ArgValues;
    }
  | { readonly type: 'effects-consumed'; readonly ids: readonly number[] }
  | { readonly type: 'query-changed'; readonly query: string; readonly spec?: ArgSpec | undefined }
  | { readonly type: 'activate-entry'; readonly entry: PaletteEntry; readonly ctx: PaletteContext }
  | {
      readonly type: 'preflight-succeeded';
      readonly attemptId: number;
      readonly entryId: string;
      readonly command: PaletteCommand;
      readonly ctx: PaletteContext;
      readonly result:
        | { readonly mode: 'run'; readonly values?: ArgValues; readonly payloads?: ArgPayloads }
        | { readonly mode: 'palette'; readonly values?: ArgValues }
        | { readonly mode: 'unavailable' };
    }
  | { readonly type: 'preflight-failed'; readonly attemptId: number; readonly error: string }
  | {
      readonly type: 'options-loaded';
      readonly attemptId: number;
      readonly options: readonly Option[];
    }
  | { readonly type: 'options-failed'; readonly attemptId: number; readonly error: string }
  | {
      readonly type: 'review-loaded';
      readonly attemptId: number;
      readonly command: PaletteCommand;
      readonly ctx: PaletteContext;
      readonly content: ReviewContent | null;
    }
  | { readonly type: 'review-failed'; readonly attemptId: number; readonly error: string }
  | {
      readonly type: 'paths-loaded';
      readonly attemptId: number;
      readonly suggestions: readonly PathSuggestionLike[];
    }
  | { readonly type: 'paths-failed'; readonly attemptId: number; readonly error: string }
  | {
      readonly type: 'accept-value';
      readonly command: PaletteCommand;
      readonly ctx: PaletteContext;
      readonly value: string;
      readonly label: string;
      readonly payload?: unknown;
    }
  | {
      readonly type: 'accept-review-choice';
      readonly command: PaletteCommand;
      readonly ctx: PaletteContext;
      readonly choice: ReviewChoice;
    }
  | {
      readonly type: 'fill-path';
      readonly path: string;
    }
  | {
      readonly type: 'back';
      readonly command?: PaletteCommand | undefined;
      readonly ctx: PaletteContext;
    }
  | {
      readonly type: 'flow-failed';
      readonly entryId?: string | undefined;
      readonly content: CommandErrorContent;
    }
  | {
      readonly type: 'run-succeeded';
      readonly attemptId: number;
      readonly outcome: CommandOutcome | void;
    }
  | { readonly type: 'run-failed'; readonly attemptId: number; readonly error: string }
  | { readonly type: 'outcome-action'; readonly value: string };

export const initialPaletteState: PaletteState = {
  kind: 'closed',
  effects: [],
  nextEffectId: 1,
  nextAttemptId: 1,
};

export function paletteReducer(state: PaletteState, event: PaletteEvent): PaletteState {
  switch (event.type) {
    case 'closed':
      return withBase(state, { kind: 'closed' });

    case 'opened':
      return withBase(state, searchState(state));

    case 'autostart':
      if (event.command.preflight) {
        return startPreflight(state, event.entryId, event.command, event.values);
      }
      if (event.command.args?.length) {
        return startFlow(state, event.entryId, event.command, event.ctx, event.values, {});
      }
      return withBase(state, searchState(state));

    case 'effects-consumed':
      return {
        ...state,
        effects: state.effects.filter((effect) => !event.ids.includes(effect.id)),
      };

    case 'query-changed':
      return queryChanged(state, event.query, event.spec);

    case 'activate-entry':
      return activateEntry(state, event.entry, event.ctx);

    case 'preflight-succeeded':
      return preflightSucceeded(state, event);

    case 'preflight-failed':
      return preflightFailed(state, event.attemptId, event.error);

    case 'options-loaded':
      return updateOptions(state, event.attemptId, { options: event.options, error: null });

    case 'options-failed':
      return updateOptions(state, event.attemptId, { options: [], error: event.error });

    case 'review-loaded':
      return reviewLoaded(state, event.attemptId, event.command, event.ctx, event.content);

    case 'review-failed':
      return updateReview(state, event.attemptId, { content: null, error: event.error });

    case 'paths-loaded':
      return updatePaths(state, event.attemptId, { suggestions: event.suggestions, error: null });

    case 'paths-failed':
      return updatePaths(state, event.attemptId, { suggestions: [], error: event.error });

    case 'accept-value':
      return acceptValue(state, event.command, event.ctx, event.value, event.label, event.payload);

    case 'accept-review-choice':
      if (event.choice.intent === 'cancel') {
        return withBase(state, { kind: 'closed' });
      }
      return acceptValue(
        state,
        event.command,
        event.ctx,
        event.choice.value,
        event.choice.label,
        event.choice.payload,
      );

    case 'fill-path':
      return fillPath(state, event.path);

    case 'back':
      return back(state, event.command, event.ctx);

    case 'flow-failed':
      if (state.kind === 'step') {
        return withBase(state, {
          kind: 'error',
          content: event.content,
          entryId: state.flow.entryId,
          viewKey: `error-flow-${state.flow.entryId}`,
        });
      }
      if (state.kind === 'search') {
        return withBase(state, {
          kind: 'error',
          content: event.content,
          entryId: event.entryId ?? null,
          viewKey: `error-flow-${event.entryId ?? 'local'}`,
        });
      }
      return state;

    case 'run-succeeded':
      return runSucceeded(state, event.attemptId, event.outcome);

    case 'run-failed':
      return runFailed(state, event.attemptId, event.error);

    case 'outcome-action':
      return event.value === 'close' || event.value === 'cancel'
        ? withBase(state, { kind: 'closed' })
        : state;
  }
}

export function currentStep(command: PaletteCommand | null, state: PaletteState): ArgSpec | null {
  if (state.kind !== 'step') {
    return null;
  }
  return command?.args?.[state.flow.stepIndex] ?? null;
}

export function initialTextQuery(
  args: readonly ArgSpec[],
  stepIndex: number,
  ctx: PaletteContext,
  values: ArgValues,
) {
  const spec = args[stepIndex];
  return spec?.kind === 'text' ? (values[spec.key] ?? spec.default?.(ctx, values) ?? '') : '';
}

function withBase(previous: PaletteState, next: PaletteStateBody): PaletteState {
  return {
    ...next,
    effects: previous.effects,
    nextEffectId: previous.nextEffectId,
    nextAttemptId: previous.nextAttemptId,
  } as PaletteState;
}

function searchState(_state: PaletteState): SearchStateBody {
  return {
    kind: 'search',
    query: '',
    inlineError: null,
    preflightAttemptId: null,
    runAttemptId: null,
    viewKey: 'recent',
  };
}

function enqueue(
  state: PaletteState,
  effect: PaletteEffectInput,
): PaletteState & { readonly effects: readonly PaletteEffect[] } {
  const nextEffect = { ...effect, id: state.nextEffectId } as PaletteEffect;
  return {
    ...state,
    effects: [...state.effects, nextEffect],
    nextEffectId: state.nextEffectId + 1,
  };
}

function nextAttempt(state: PaletteState) {
  return { attemptId: state.nextAttemptId, nextAttemptId: state.nextAttemptId + 1 };
}

function startPreflight(
  state: PaletteState,
  entryId: string,
  command: PaletteCommand,
  values: ArgValues,
): PaletteState {
  if (isBusy(state)) {
    return state;
  }
  const { attemptId, nextAttemptId } = nextAttempt(state);
  const base = withBase(
    { ...state, nextAttemptId },
    {
      kind: 'search',
      query: state.kind === 'search' ? state.query : '',
      inlineError: null,
      preflightAttemptId: attemptId,
      runAttemptId: null,
      viewKey: state.kind === 'search' ? state.viewKey : 'recent',
    },
  );
  return enqueue(base, {
    kind: 'preflight',
    attemptId,
    entryId,
    commandId: command.id,
    values,
  });
}

function activateEntry(
  state: PaletteState,
  entry: PaletteEntry,
  ctx: PaletteContext,
): PaletteState {
  if (state.kind !== 'search' || isBusy(state)) {
    return state;
  }

  if (!entry.command) {
    return startRun(state, entry.id, undefined, {}, {});
  }

  const values = entry.values ?? {};
  if (entry.command.preflight) {
    return startPreflight(state, entry.id, entry.command, values);
  }

  if (entry.command.args?.length) {
    return startFlow(state, entry.id, entry.command, ctx, values, {});
  }

  return startRun(state, entry.id, entry.command.id, {}, {});
}

function preflightSucceeded(
  state: PaletteState,
  event: Extract<PaletteEvent, { type: 'preflight-succeeded' }>,
): PaletteState {
  if (state.kind !== 'search' || state.preflightAttemptId !== event.attemptId) {
    return state;
  }

  if (event.result.mode === 'unavailable') {
    return { ...state, preflightAttemptId: null };
  }

  if (event.result.mode === 'palette') {
    return startFlow(
      { ...state, preflightAttemptId: null },
      event.entryId,
      event.command,
      event.ctx,
      event.result.values ?? {},
      {},
    );
  }

  return startRun(
    { ...state, preflightAttemptId: null },
    event.entryId,
    event.command.id,
    event.result.values ?? {},
    event.result.payloads ?? {},
  );
}

function preflightFailed(state: PaletteState, attemptId: number, error: string): PaletteState {
  if (state.kind !== 'search' || state.preflightAttemptId !== attemptId) {
    return state;
  }
  return { ...state, preflightAttemptId: null, inlineError: error };
}

function startFlow(
  state: PaletteState,
  entryId: string,
  command: PaletteCommand,
  ctx: PaletteContext,
  initialValues: ArgValues,
  initialPayloads: ArgPayloads,
): PaletteState {
  const args = command.args ?? [];
  const labels = Object.fromEntries(
    args
      .filter((arg) => initialValues[arg.key] !== undefined)
      .map((arg) => [
        arg.key,
        labelForValue(arg, initialValues[arg.key] as string, ctx, initialValues),
      ]),
  );
  const stepIndex = firstUnfilledStep(args, initialValues);
  const flow: PaletteFlow = {
    entryId,
    commandId: command.id,
    values: initialValues,
    payloads: initialPayloads,
    labels,
    stepIndex,
  };
  const query = initialTextQuery(args, stepIndex, ctx, initialValues);
  return enterStep(state, flow, args[stepIndex], query, null);
}

function enterStep(
  state: PaletteState,
  flow: PaletteFlow,
  spec: ArgSpec | undefined,
  query: string,
  inlineError: string | null,
): PaletteState {
  const { stepData, effect, nextAttemptId } = makeStepData(state, flow, spec, query);
  const base = withBase(
    { ...state, nextAttemptId },
    {
      kind: 'step',
      flow,
      query,
      stepData,
      inlineError,
      runAttemptId: null,
      lastFilledPath: null,
      viewKey: `wizard-${flow.stepIndex}`,
    },
  );
  return effect ? enqueue(base, effect) : base;
}

function makeStepData(
  state: PaletteState,
  flow: PaletteFlow,
  spec: ArgSpec | undefined,
  query: string,
): {
  readonly stepData: StepData;
  readonly effect?: PaletteEffectInput | undefined;
  readonly nextAttemptId: number;
} {
  if (!spec) {
    return { stepData: { kind: 'text' }, nextAttemptId: state.nextAttemptId };
  }

  if (spec.kind === 'select' || spec.kind === 'combo') {
    const { attemptId, nextAttemptId } = nextAttempt(state);
    return {
      stepData: { kind: spec.kind, options: [], loading: true, error: null, attemptId },
      effect: {
        kind: 'loadOptions',
        attemptId,
        entryId: flow.entryId,
        commandId: flow.commandId,
        stepIndex: flow.stepIndex,
        values: flow.values,
      },
      nextAttemptId,
    };
  }

  if (spec.kind === 'review') {
    const { attemptId, nextAttemptId } = nextAttempt(state);
    return {
      stepData: { kind: 'review', content: null, loading: true, error: null, attemptId },
      effect: {
        kind: 'loadReview',
        attemptId,
        entryId: flow.entryId,
        commandId: flow.commandId,
        stepIndex: flow.stepIndex,
        values: flow.values,
        payloads: flow.payloads,
      },
      nextAttemptId,
    };
  }

  if (spec.kind === 'path') {
    const { attemptId, nextAttemptId } = nextAttempt(state);
    return {
      stepData: {
        kind: 'path',
        suggestions: [],
        suggestionsQuery: query,
        loading: true,
        error: null,
        attemptId,
      },
      effect: { kind: 'suggestPaths', attemptId, query },
      nextAttemptId,
    };
  }

  return { stepData: { kind: 'text' }, nextAttemptId: state.nextAttemptId };
}

function queryChanged(state: PaletteState, query: string, spec: ArgSpec | undefined): PaletteState {
  if (state.kind === 'search') {
    return { ...state, query, inlineError: null };
  }

  if (state.kind !== 'step') {
    return state;
  }

  if (spec?.kind !== 'path') {
    return { ...state, query, inlineError: null, lastFilledPath: null };
  }

  const { attemptId, nextAttemptId } = nextAttempt(state);
  const previousSuggestions = state.stepData.kind === 'path' ? state.stepData.suggestions : [];
  const previousSuggestionsQuery =
    state.stepData.kind === 'path' ? state.stepData.suggestionsQuery : '';
  const next = {
    ...state,
    query,
    inlineError: null,
    lastFilledPath: null,
    nextAttemptId,
    stepData: {
      kind: 'path' as const,
      suggestions: previousSuggestions,
      suggestionsQuery: previousSuggestionsQuery,
      loading: true,
      error: null,
      attemptId,
    },
  };
  return enqueue(next, { kind: 'suggestPaths', attemptId, query });
}

function acceptValue(
  state: PaletteState,
  command: PaletteCommand,
  ctx: PaletteContext,
  value: string,
  label: string,
  payload: unknown,
): PaletteState {
  if (state.kind !== 'step') {
    return state;
  }
  const args = command.args ?? [];
  const spec = args[state.flow.stepIndex];
  if (!spec || (!value && spec.kind !== 'text')) {
    return state;
  }

  const nextValues = { ...state.flow.values, [spec.key]: value };
  const nextPayloads = { ...state.flow.payloads, [spec.key]: payload };
  const nextLabels = { ...state.flow.labels, [spec.key]: label };
  const finishOnAccept =
    (spec.kind === 'select' || spec.kind === 'combo') &&
    (spec.finishOnAccept?.(value, payload, ctx, nextValues) ?? false);
  const nextStepIndex = nextVisibleStep(
    args,
    state.flow.stepIndex + 1,
    ctx,
    nextValues,
    nextPayloads,
  );
  const nextFlow = {
    ...state.flow,
    values: nextValues,
    payloads: nextPayloads,
    labels: nextLabels,
    stepIndex: nextStepIndex,
  };

  if (finishOnAccept || nextStepIndex >= args.length) {
    return startRun(state, state.flow.entryId, command.id, nextValues, nextPayloads);
  }

  return enterStep(state, nextFlow, args[nextStepIndex], '', null);
}

function fillPath(state: PaletteState, path: string): PaletteState {
  if (state.kind !== 'step' || state.stepData.kind !== 'path') {
    return state;
  }
  const { attemptId, nextAttemptId } = nextAttempt(state);
  const next = {
    ...state,
    query: path,
    lastFilledPath: path,
    nextAttemptId,
    stepData: {
      kind: 'path' as const,
      suggestions: state.stepData.suggestions,
      suggestionsQuery: state.stepData.suggestionsQuery,
      loading: true,
      error: null,
      attemptId,
    },
  };
  return enqueue(next, { kind: 'suggestPaths', attemptId, query: path });
}

function back(
  state: PaletteState,
  command: PaletteCommand | undefined,
  ctx: PaletteContext,
): PaletteState {
  if (state.kind === 'search') {
    return withBase(state, { kind: 'closed' });
  }
  if (state.kind === 'result' || state.kind === 'error') {
    return withBase(state, { kind: 'closed' });
  }
  if (state.kind !== 'step' || !command) {
    return withBase(state, searchState(state));
  }

  const args = command.args ?? [];
  const previous = prevVisibleStep(
    args,
    state.flow.stepIndex,
    ctx,
    state.flow.values,
    state.flow.payloads,
  );
  if (previous === null) {
    return withBase(state, searchState(state));
  }

  const previousKey = args[previous]?.key;
  const nextValues = { ...state.flow.values };
  const nextPayloads = { ...state.flow.payloads };
  const nextLabels = { ...state.flow.labels };
  if (previousKey) {
    delete nextValues[previousKey];
    delete nextPayloads[previousKey];
    delete nextLabels[previousKey];
  }
  const nextFlow = {
    ...state.flow,
    values: nextValues,
    payloads: nextPayloads,
    labels: nextLabels,
    stepIndex: previous,
  };
  return enterStep(state, nextFlow, args[previous], '', null);
}

function startRun(
  state: PaletteState,
  entryId: string,
  commandId: string | undefined,
  values: ArgValues,
  payloads: ArgPayloads,
): PaletteState {
  if (isBusy(state)) {
    return state;
  }
  const { attemptId, nextAttemptId } = nextAttempt(state);
  const next = {
    ...state,
    nextAttemptId,
    inlineError: null,
    runAttemptId: attemptId,
  };
  return enqueue(next, {
    kind: 'run',
    attemptId,
    entryId,
    commandId,
    values,
    payloads,
  });
}

function runSucceeded(
  state: PaletteState,
  attemptId: number,
  outcome: CommandOutcome | void,
): PaletteState {
  if (!runMatches(state, attemptId)) {
    return state;
  }

  if (!outcome || outcome.kind === 'close') {
    return withBase(state, { kind: 'closed' });
  }

  if (outcome.kind === 'result') {
    return withBase(
      { ...state, effects: [] },
      {
        kind: 'result',
        content: outcome.content,
        entryId: entryIdForOutcome(state),
        viewKey: `result-${attemptId}`,
      },
    );
  }

  return withBase(
    { ...state, effects: [] },
    {
      kind: 'error',
      content: outcome.content,
      entryId: entryIdForOutcome(state),
      viewKey: `error-${attemptId}`,
    },
  );
}

function runFailed(state: PaletteState, attemptId: number, error: string): PaletteState {
  if (!runMatches(state, attemptId)) {
    return state;
  }
  if (state.kind === 'search' || state.kind === 'step') {
    return { ...state, runAttemptId: null, inlineError: error };
  }
  return state;
}

function runMatches(state: PaletteState, attemptId: number) {
  return (state.kind === 'search' || state.kind === 'step') && state.runAttemptId === attemptId;
}

function entryIdForOutcome(state: PaletteState) {
  if (state.kind === 'step') {
    return state.flow.entryId;
  }
  return null;
}

function updateOptions(
  state: PaletteState,
  attemptId: number,
  input: { readonly options: readonly Option[]; readonly error: string | null },
): PaletteState {
  if (
    state.kind !== 'step' ||
    (state.stepData.kind !== 'select' && state.stepData.kind !== 'combo') ||
    state.stepData.attemptId !== attemptId
  ) {
    return state;
  }
  return {
    ...state,
    stepData: {
      ...state.stepData,
      options: input.options,
      loading: false,
      error: input.error,
    },
  };
}

function reviewLoaded(
  state: PaletteState,
  attemptId: number,
  command: PaletteCommand,
  ctx: PaletteContext,
  content: ReviewContent | null,
): PaletteState {
  if (
    state.kind !== 'step' ||
    state.stepData.kind !== 'review' ||
    state.stepData.attemptId !== attemptId
  ) {
    return state;
  }
  if (content === null) {
    const args = command.args ?? [];
    const nextStepIndex = nextVisibleStep(
      args,
      state.flow.stepIndex + 1,
      ctx,
      state.flow.values,
      state.flow.payloads,
    );
    if (nextStepIndex >= args.length) {
      return startRun(
        state,
        state.flow.entryId,
        state.flow.commandId,
        state.flow.values,
        state.flow.payloads,
      );
    }
    const nextFlow = { ...state.flow, stepIndex: nextStepIndex };
    return enterStep(state, nextFlow, args[nextStepIndex], '', null);
  }
  return updateReview(state, attemptId, { content, error: null });
}

function updateReview(
  state: PaletteState,
  attemptId: number,
  input: { readonly content: ReviewContent | null; readonly error: string | null },
): PaletteState {
  if (
    state.kind !== 'step' ||
    state.stepData.kind !== 'review' ||
    state.stepData.attemptId !== attemptId
  ) {
    return state;
  }
  return {
    ...state,
    stepData: {
      ...state.stepData,
      content: input.content,
      loading: false,
      error: input.error,
    },
  };
}

function updatePaths(
  state: PaletteState,
  attemptId: number,
  input: { readonly suggestions: readonly PathSuggestionLike[]; readonly error: string | null },
): PaletteState {
  if (
    state.kind !== 'step' ||
    state.stepData.kind !== 'path' ||
    state.stepData.attemptId !== attemptId
  ) {
    return state;
  }
  return {
    ...state,
    stepData: {
      ...state.stepData,
      suggestions: input.suggestions,
      suggestionsQuery: state.query,
      loading: false,
      error: input.error,
    },
  };
}

export function isBusy(state: PaletteState) {
  return (
    (state.kind === 'search' &&
      (state.preflightAttemptId !== null || state.runAttemptId !== null)) ||
    (state.kind === 'step' && state.runAttemptId !== null)
  );
}
