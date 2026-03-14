export type EntityType = "project" | "task" | "spark";

export type FileSelectionMode = "file" | "directory" | "either";

export interface FileValue {
  readonly path: string;
  readonly kind: "file" | "dir";
}

export interface CommandMetadata<TId extends string = string> {
  readonly id: TId;
  readonly label: string;
  readonly aliases?: ReadonlyArray<string>;
}

export interface SelectedOption {
  readonly id: string;
  readonly label: string;
}

export interface CommandResolvedValue<TValue = unknown> {
  readonly value: TValue;
  readonly label: string;
}

interface CommandStepBase {
  readonly id: string;
  readonly placeholder?: string;
  readonly labelPrefix?: string;
  readonly initialDraft?: string;
  readonly emptyErrorMessage?: string;
}

export interface EntitySearchStep extends CommandStepBase {
  readonly kind: "entity-search";
  readonly entityType: EntityType;
  readonly contextId?: string;
}

export interface TextStep extends CommandStepBase {
  readonly kind: "text";
  readonly allowEmpty?: boolean;
}

export interface MarkdownStep extends CommandStepBase {
  readonly kind: "markdown";
  readonly allowEmpty?: boolean;
}

export interface FileStep extends CommandStepBase {
  readonly kind: "file";
  readonly allowEmpty?: boolean;
  readonly selectionMode?: FileSelectionMode;
}

export type CommandStep = EntitySearchStep | TextStep | MarkdownStep | FileStep;

export interface HistoryFrame {
  readonly step: CommandStep;
  readonly draft: string;
  readonly value: CommandResolvedValue;
}

export type CommandFlowValues = Readonly<Record<string, CommandResolvedValue>>;

export interface CommandEffectAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface CommandEffect {
  readonly variant: "success" | "error" | "message";
  readonly message: string;
  readonly description?: string;
  readonly action?: CommandEffectAction;
  readonly cancel?: CommandEffectAction;
}

export interface CommandStartStepResult {
  readonly type: "step";
  readonly step: CommandStep;
}

export interface CommandStartCompleteResult {
  readonly type: "complete";
  readonly effect?: CommandEffect;
}

export interface CommandStartCloseResult {
  readonly type: "close";
  readonly effect?: CommandEffect;
}

export type CommandStartResult =
  | CommandStartStepResult
  | CommandStartCompleteResult
  | CommandStartCloseResult;

export interface CommandSubmitInput {
  readonly step: CommandStep;
  readonly draft: string;
  readonly history: ReadonlyArray<HistoryFrame>;
  readonly values: CommandFlowValues;
  readonly selected?: SelectedOption;
}

export interface CommandSubmitStayResult {
  readonly type: "stay";
  readonly error?: string;
  readonly draft?: string;
}

export interface CommandSubmitNextResult {
  readonly type: "next";
  readonly frame: HistoryFrame;
  readonly step: CommandStep;
}

export interface CommandSubmitCompleteResult {
  readonly type: "complete";
  readonly frame?: HistoryFrame;
  readonly effect?: CommandEffect;
}

export interface CommandSubmitCloseResult {
  readonly type: "close";
  readonly effect?: CommandEffect;
}

export type CommandSubmitResult =
  | CommandSubmitStayResult
  | CommandSubmitNextResult
  | CommandSubmitCompleteResult
  | CommandSubmitCloseResult;

export interface CommandController {
  start: () => CommandStartResult | Promise<CommandStartResult>;
  submit: (
    input: CommandSubmitInput,
  ) => CommandSubmitResult | Promise<CommandSubmitResult>;
}

export type CommandControllerFactory = () => CommandController;

export interface CommandDefinition<
  TId extends string = string,
> extends CommandMetadata<TId> {
  readonly createController: CommandControllerFactory;
}
