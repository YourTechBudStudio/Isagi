// Public surface of the input-flow module: a reusable, presentational system
// for rendering and driving multi-step input screens (text, select, combo,
// multi-select, confirm, path, review). Consumers import from here rather than
// reaching into individual files.
export {
  InputFlowScreenView,
  InputFlowBody,
  InputFlowControl,
  type InputFlowScreenViewProps,
  type InputFlowBodyProps,
  type InputFlowControlProps,
} from './InputFlowScreenView.js';
export {
  inputFlowSelectableLength,
  inputFlowHasTextInput,
  withSelectedIndex,
  type InputFlowScreen,
  type InputFlowOption,
  type InputFlowPathSuggestion,
  type InputFlowReviewChoice,
  type InputFlowReviewContent,
} from './types.js';
