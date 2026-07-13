import type {
  WorkflowAgentHarness,
  WorkflowPromptInput,
  WorkflowPromptModifier,
} from '@yourtechbudstudio/isagi-workflow-sdk';
import { Data, Effect } from 'effect';

import { harnessDefinition } from '../agent-sessions/harness/definitions.js';

export type WorkflowPromptOperation =
  | 'spawn_agent_session'
  | 'send_agent_prompt'
  | 'run_headless_agent';

export class WorkflowPromptInputError extends Data.TaggedError('WorkflowPromptInputError')<{
  readonly reason: 'invalid_prompt' | 'invalid_modifier' | 'empty_input';
  readonly message: string;
  readonly harness: WorkflowAgentHarness;
  readonly operation?: WorkflowPromptOperation | undefined;
  readonly modifierIndex?: number | undefined;
  readonly modifierKind?: string | undefined;
  readonly modifierName?: string | undefined;
}> {}

export function renderWorkflowPrompt(input: {
  readonly harness: WorkflowAgentHarness;
  readonly promptInput: WorkflowPromptInput;
  readonly operation?: WorkflowPromptOperation | undefined;
}): string {
  const prompt = validatePrompt(input);
  const modifiers = validateModifiers(input);
  const promptIsPresent = prompt !== undefined && !/^\s*$/u.test(prompt);

  if (modifiers.length === 0 && !promptIsPresent) {
    throw promptError(input, {
      reason: 'empty_input',
      message: 'Workflow prompt input must include a modifier or a non-whitespace prompt.',
    });
  }

  const definition = harnessDefinition(input.harness);
  const tokens = modifiers.map((modifier) =>
    modifier.kind === 'skill'
      ? definition.prompt.renderSkillToken(modifier.name)
      : definition.prompt.renderCommandToken(modifier.name),
  );
  if (!promptIsPresent) return tokens.join(' ');
  return tokens.length === 0 ? prompt : `${tokens.join(' ')} ${prompt}`;
}

export function renderWorkflowPromptEffect(
  input: Parameters<typeof renderWorkflowPrompt>[0],
): Effect.Effect<string, WorkflowPromptInputError> {
  return Effect.try({
    try: () => renderWorkflowPrompt(input),
    catch: (cause) => {
      if (cause instanceof WorkflowPromptInputError) return cause;
      throw cause;
    },
  });
}

function validatePrompt(input: {
  readonly harness: WorkflowAgentHarness;
  readonly promptInput: WorkflowPromptInput;
  readonly operation?: WorkflowPromptOperation | undefined;
}): string | undefined {
  const prompt: unknown = input.promptInput.prompt;
  if (prompt === undefined || typeof prompt === 'string') return prompt;
  throw promptError(input, {
    reason: 'invalid_prompt',
    message: 'Workflow prompt must be a string when provided.',
  });
}

function validateModifiers(input: {
  readonly harness: WorkflowAgentHarness;
  readonly promptInput: WorkflowPromptInput;
  readonly operation?: WorkflowPromptOperation | undefined;
}): readonly WorkflowPromptModifier[] {
  const modifiers: unknown = input.promptInput.modifiers;
  if (modifiers === undefined) return [];
  if (!Array.isArray(modifiers)) {
    throw promptError(input, {
      reason: 'invalid_modifier',
      message: 'Workflow prompt modifiers must be an array when provided.',
    });
  }

  const validated = Array.from(modifiers, (modifier: unknown, modifierIndex) =>
    validateModifier(input, modifier, modifierIndex),
  );
  const commandIndex = validated.findIndex((modifier) => modifier.kind === 'command');
  if (commandIndex !== -1 && validated.length !== 1) {
    const command = validated[commandIndex]!;
    throw promptError(input, {
      reason: 'invalid_modifier',
      message: 'A command must be the sole workflow prompt modifier.',
      modifierIndex: commandIndex,
      modifierKind: command.kind,
      modifierName: command.name,
    });
  }
  return validated;
}

function validateModifier(
  input: {
    readonly harness: WorkflowAgentHarness;
    readonly promptInput: WorkflowPromptInput;
    readonly operation?: WorkflowPromptOperation | undefined;
  },
  modifier: unknown,
  modifierIndex: number,
): WorkflowPromptModifier {
  if (modifier === null || typeof modifier !== 'object' || Array.isArray(modifier)) {
    throw promptError(input, {
      reason: 'invalid_modifier',
      message: `Workflow prompt modifier at index ${modifierIndex} must be an object.`,
      modifierIndex,
    });
  }

  const candidate = modifier as { readonly kind?: unknown; readonly name?: unknown };
  if (candidate.kind !== 'skill' && candidate.kind !== 'command') {
    throw promptError(input, {
      reason: 'invalid_modifier',
      message: `Workflow prompt modifier at index ${modifierIndex} must have kind "skill" or "command".`,
      modifierIndex,
      ...(typeof candidate.kind === 'string' ? { modifierKind: candidate.kind } : {}),
    });
  }
  if (typeof candidate.name !== 'string') {
    throw promptError(input, {
      reason: 'invalid_modifier',
      message: `Workflow prompt modifier at index ${modifierIndex} must have a string name.`,
      modifierIndex,
      modifierKind: candidate.kind,
    });
  }
  if (candidate.name.length === 0) {
    throw promptError(input, {
      reason: 'invalid_modifier',
      message: `Workflow prompt modifier at index ${modifierIndex} must have a non-empty name.`,
      modifierIndex,
      modifierKind: candidate.kind,
    });
  }
  if (/\s/u.test(candidate.name) || /[\p{Cc}\p{Cf}]/u.test(candidate.name)) {
    throw promptError(input, {
      reason: 'invalid_modifier',
      message: `Workflow prompt modifier at index ${modifierIndex} cannot contain whitespace or control characters.`,
      modifierIndex,
      modifierKind: candidate.kind,
    });
  }
  if (candidate.name.startsWith('/') || candidate.name.startsWith('$')) {
    throw promptError(input, {
      reason: 'invalid_modifier',
      message: `Workflow prompt modifier at index ${modifierIndex} cannot include a leading harness sigil.`,
      modifierIndex,
      modifierKind: candidate.kind,
    });
  }

  return { kind: candidate.kind, name: candidate.name };
}

function promptError(
  input: {
    readonly harness: WorkflowAgentHarness;
    readonly operation?: WorkflowPromptOperation | undefined;
  },
  details: Omit<ConstructorParameters<typeof WorkflowPromptInputError>[0], 'harness' | 'operation'>,
) {
  return new WorkflowPromptInputError({
    ...details,
    harness: input.harness,
    ...(input.operation === undefined ? {} : { operation: input.operation }),
  });
}
