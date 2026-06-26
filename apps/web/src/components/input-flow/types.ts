export interface InputFlowOption<Payload = unknown> {
  readonly value: string;
  readonly label?: string | undefined;
  readonly hint?: string | undefined;
  readonly isDefault?: boolean | undefined;
  readonly create?: boolean | undefined;
  readonly payload?: Payload | undefined;
}

export interface InputFlowPathSuggestion {
  readonly label: string;
  readonly path: string;
  readonly hidden?: boolean | undefined;
}

export interface InputFlowReviewChoice<Payload = unknown> {
  readonly value: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly intent?: 'default' | 'danger' | 'cancel' | undefined;
  readonly payload?: Payload | undefined;
}

export interface InputFlowReviewContent<Payload = unknown> {
  readonly title: string;
  readonly body: string;
  readonly items: readonly {
    readonly label: string;
    readonly detail?: string | undefined;
    readonly envKeys?: readonly string[] | undefined;
  }[];
  readonly choices: readonly InputFlowReviewChoice<Payload>[];
}

export type InputFlowScreen =
  | {
      readonly kind: 'text';
      readonly label: string;
      readonly value: string;
      readonly placeholder?: string | undefined;
      readonly hint?: string | undefined;
      readonly error?: string | null | undefined;
    }
  | {
      readonly kind: 'select';
      readonly label: string;
      readonly options: readonly InputFlowOption[];
      readonly selectedIndex: number | null;
      readonly query?: string | undefined;
      readonly placeholder?: string | undefined;
      readonly hint?: string | undefined;
      readonly loading?: boolean | undefined;
      readonly error?: string | null | undefined;
    }
  | {
      readonly kind: 'combo';
      readonly label: string;
      readonly query: string;
      readonly options: readonly InputFlowOption[];
      readonly selectedIndex: number | null;
      readonly placeholder?: string | undefined;
      readonly hint?: string | undefined;
      readonly loading?: boolean | undefined;
      readonly error?: string | null | undefined;
    }
  | {
      readonly kind: 'multi-select';
      readonly label: string;
      readonly options: readonly InputFlowOption[];
      readonly selectedValues: readonly string[];
      readonly selectedIndex: number | null;
      readonly hint?: string | undefined;
      readonly error?: string | null | undefined;
    }
  | {
      readonly kind: 'confirm';
      readonly label: string;
      readonly value: boolean;
      readonly selectedIndex: number | null;
      readonly error?: string | null | undefined;
    }
  | {
      readonly kind: 'path';
      readonly label: string;
      readonly value: string;
      readonly suggestions: readonly InputFlowPathSuggestion[];
      readonly selectedIndex: number | null;
      readonly placeholder?: string | undefined;
      readonly loading: boolean;
      readonly stale: boolean;
      readonly error?: string | null | undefined;
    }
  | {
      readonly kind: 'review';
      readonly content: InputFlowReviewContent | null;
      readonly selectedIndex: number | null;
      readonly loading: boolean;
      readonly error?: string | null | undefined;
    };

export function inputFlowSelectableLength(screen: InputFlowScreen): number {
  switch (screen.kind) {
    case 'text':
      return 0;
    case 'select':
    case 'combo':
    case 'multi-select':
      return screen.options.length;
    case 'confirm':
      return 1;
    case 'path':
      return screen.stale ? 0 : screen.suggestions.length;
    case 'review':
      return screen.content?.choices.length ?? 0;
  }
}

/**
 * The text-input control a screen renders in its header, if any (its current
 * value + placeholder). Screens without one (select-without-query, multi-select,
 * confirm, review) render a static label instead.
 */
export function inputFlowQueryControl(screen: InputFlowScreen): {
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly kind: string;
} | null {
  if (screen.kind === 'text') {
    return { kind: screen.kind, value: screen.value, placeholder: screen.placeholder };
  }
  if (screen.kind === 'combo') {
    return { kind: screen.kind, value: screen.query, placeholder: screen.placeholder };
  }
  if (screen.kind === 'select' && screen.query !== undefined) {
    return { kind: screen.kind, value: screen.query, placeholder: screen.placeholder };
  }
  if (screen.kind === 'path') {
    return { kind: screen.kind, value: screen.value, placeholder: screen.placeholder };
  }
  return null;
}

/** Whether a screen owns a focusable text input (vs. relying on root-level keys). */
export function inputFlowHasTextInput(screen: InputFlowScreen): boolean {
  return inputFlowQueryControl(screen) !== null;
}

/**
 * Return the screen with its highlight set. Consumers that own selection
 * externally (via `useKeyboardSelection`) build the selection-free shape, then
 * inject the live index here at render time.
 */
export function withSelectedIndex(
  screen: InputFlowScreen,
  selectedIndex: number | null,
): InputFlowScreen {
  if (screen.kind === 'text') {
    return screen;
  }
  return { ...screen, selectedIndex };
}
