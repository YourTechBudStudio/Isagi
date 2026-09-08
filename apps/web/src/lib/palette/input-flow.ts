import type { InputFlowScreen } from '../../components/input-flow/index.js';
import { paletteCopy } from '../../copy/index.js';
import type { StepData } from './machine.js';
import { computeStepOptions } from './model.js';
import { nextPathIntent, pathSuggestionsAreStale } from './path-step.js';
import type { ArgSpec } from './types.js';

// Builds the selection-free shape of a step's screen. The live highlight index is
// injected at render via `withSelectedIndex`, from whichever owner the screen has:
// the palette machine on path steps, `useKeyboardSelection` on all the others.
export function commandStepToInputFlowScreen({
  spec,
  stepData,
  query,
}: {
  readonly spec: ArgSpec;
  readonly stepData: StepData;
  readonly query: string;
}): InputFlowScreen {
  if (spec.kind === 'text') {
    return {
      kind: 'text',
      label: spec.label,
      value: query.trim(),
      placeholder: spec.placeholder,
    };
  }

  if (spec.kind === 'path' && stepData.kind === 'path') {
    // Freshness and the next Enter action both come from the one path policy the
    // reducer uses, so what the panel says and what Enter does share a source.
    const view = { query, stepData };
    return {
      kind: 'path',
      label: spec.label,
      value: query.trim(),
      suggestions: stepData.suggestions,
      selectedIndex: null,
      loading: stepData.loading,
      stale: pathSuggestionsAreStale(view),
      enterIntent: nextPathIntent(view).kind,
      error: stepData.error,
      placeholder: spec.placeholder,
    };
  }

  if (spec.kind === 'review' && stepData.kind === 'review') {
    return {
      kind: 'review',
      content: stepData.content,
      selectedIndex: null,
      loading: stepData.loading,
      error: stepData.error,
    };
  }

  const loadedOptions =
    stepData.kind === 'select' || stepData.kind === 'combo' ? stepData.options : [];
  const options = computeStepOptions(spec, loadedOptions, query);
  const error = stepData.kind === 'select' || stepData.kind === 'combo' ? stepData.error : null;
  const loading =
    stepData.kind === 'select' || stepData.kind === 'combo' ? stepData.loading : false;

  if (spec.kind === 'combo') {
    return {
      kind: 'combo',
      label: spec.label,
      query,
      options,
      selectedIndex: null,
      placeholder: paletteCopy.placeholders.chooseOrTypeName,
      hint: spec.emptyHint,
      loading,
      error,
    };
  }

  if (spec.kind === 'select') {
    return {
      kind: 'select',
      label: spec.label,
      options,
      selectedIndex: null,
      query,
      placeholder: paletteCopy.placeholders.choose,
      hint: spec.emptyHint,
      loading,
      error,
    };
  }

  return {
    kind: 'text',
    label: spec.label,
    value: query.trim(),
  };
}
