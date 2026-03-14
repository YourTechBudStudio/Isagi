import type {
  CommandController,
  CommandEffect,
  CommandFlowValues,
  CommandResolvedValue,
  CommandStartResult,
  CommandStep,
  CommandSubmitInput,
  CommandSubmitResult,
  FileValue,
  HistoryFrame,
  SelectedOption,
} from "./types";

type FlowContext = {
  readonly history: ReadonlyArray<HistoryFrame>;
  readonly values: CommandFlowValues;
};

type FlowResolveInput = FlowContext & {
  readonly step: CommandStep;
  readonly draft: string;
  readonly selected?: SelectedOption;
};

type FlowStepConfig = {
  readonly id: string;
  readonly step: CommandStep | ((context: FlowContext) => CommandStep);
  readonly validate?: (
    input: FlowResolveInput,
  ) => string | null | Promise<string | null>;
  readonly resolveValue?: (
    input: FlowResolveInput,
  ) => CommandResolvedValue | Promise<CommandResolvedValue>;
  readonly nextStepId?:
    | string
    | null
    | ((
        input: FlowResolveInput & {
          readonly resolvedValue: CommandResolvedValue;
        },
      ) => string | null | Promise<string | null>);
};

type FlowCommandConfig = {
  readonly steps: ReadonlyArray<FlowStepConfig>;
  readonly onComplete?: (
    context: FlowContext,
  ) => void | CommandEffect | Promise<void | CommandEffect>;
};

function resolveStep(
  config: FlowStepConfig,
  context: FlowContext,
): CommandStep {
  return typeof config.step === "function" ? config.step(context) : config.step;
}

function getDefaultEmptyError(step: CommandStep): string {
  switch (step.kind) {
    case "markdown":
      return step.emptyErrorMessage ?? "You cannot submit an empty spark.";
    case "file":
      return step.emptyErrorMessage ?? "Enter a filesystem path to continue.";
    default:
      return step.emptyErrorMessage ?? "This field cannot be empty.";
  }
}

function getDefaultResolvedValue(
  input: FlowResolveInput,
): CommandResolvedValue | null {
  if (input.step.kind === "entity-search") {
    if (!input.selected) {
      return null;
    }

    return {
      value: input.selected.id,
      label: input.selected.label,
    };
  }

  if (input.step.kind === "file") {
    const trimmedDraft = input.draft.trim();
    const kind: FileValue["kind"] =
      input.step.selectionMode === "file" ? "file" : "dir";

    return {
      value: {
        path: trimmedDraft,
        kind,
      },
      label: trimmedDraft,
    };
  }

  const trimmedDraft = input.draft.trim();
  return {
    value: trimmedDraft,
    label: trimmedDraft,
  };
}

function getNextStepId(
  config: FlowStepConfig,
  input: FlowResolveInput & { readonly resolvedValue: CommandResolvedValue },
  orderedStepIds: ReadonlyArray<string>,
): string | null | Promise<string | null> {
  if (typeof config.nextStepId === "function") {
    return config.nextStepId(input);
  }

  if (config.nextStepId !== undefined) {
    return config.nextStepId;
  }

  const currentStepIndex = orderedStepIds.indexOf(config.id);
  const nextStepId = orderedStepIds[currentStepIndex + 1];
  return nextStepId ?? null;
}

export function defineFlowCommand(
  config: FlowCommandConfig,
): CommandController {
  const stepConfigsById = new Map(config.steps.map(step => [step.id, step]));
  const orderedStepIds = config.steps.map(step => step.id);

  return {
    async start(): Promise<CommandStartResult> {
      const initialContext: FlowContext = {
        history: [],
        values: {},
      };
      const firstStepId = orderedStepIds[0];

      if (!firstStepId) {
        const effect = (await config.onComplete?.(initialContext)) ?? undefined;
        return {
          type: "complete",
          effect,
        };
      }

      const firstStepConfig = stepConfigsById.get(firstStepId);
      if (!firstStepConfig) {
        return { type: "close" };
      }

      return {
        type: "step",
        step: resolveStep(firstStepConfig, initialContext),
      };
    },

    async submit(input: CommandSubmitInput): Promise<CommandSubmitResult> {
      const currentStepConfig = stepConfigsById.get(input.step.id);
      if (!currentStepConfig) {
        return { type: "close" };
      }

      const flowContext: FlowContext = {
        history: input.history,
        values: input.values,
      };
      const resolveInput: FlowResolveInput = {
        ...flowContext,
        step: input.step,
        draft: input.draft,
        selected: input.selected,
      };

      if (
        input.step.kind !== "entity-search" &&
        !input.step.allowEmpty &&
        !input.draft.trim()
      ) {
        return {
          type: "stay",
          error: getDefaultEmptyError(input.step),
        };
      }

      const customValidationError =
        await currentStepConfig.validate?.(resolveInput);
      if (customValidationError) {
        return {
          type: "stay",
          error: customValidationError,
        };
      }

      const resolvedValue = currentStepConfig.resolveValue
        ? await currentStepConfig.resolveValue(resolveInput)
        : getDefaultResolvedValue(resolveInput);

      if (!resolvedValue) {
        return {
          type: "stay",
          error: "Select an option to continue.",
        };
      }

      const frame: HistoryFrame = {
        step: input.step,
        draft: input.draft,
        value: resolvedValue,
      };

      const nextHistory = [...input.history, frame];
      const nextValues: CommandFlowValues = {
        ...input.values,
        [input.step.id]: resolvedValue,
      };
      const nextStepId = await getNextStepId(
        currentStepConfig,
        {
          ...resolveInput,
          resolvedValue,
        },
        orderedStepIds,
      );

      if (!nextStepId) {
        const effect =
          (await config.onComplete?.({
            history: nextHistory,
            values: nextValues,
          })) ?? undefined;
        return {
          type: "complete",
          frame,
          effect,
        };
      }

      const nextStepConfig = stepConfigsById.get(nextStepId);
      if (!nextStepConfig) {
        return {
          type: "complete",
          frame,
        };
      }

      return {
        type: "next",
        frame,
        step: resolveStep(nextStepConfig, {
          history: nextHistory,
          values: nextValues,
        }),
      };
    },
  };
}
