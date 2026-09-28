import type {
  OperationContext,
  WorkflowCommandModifier,
  WorkflowPromptInput,
  WorkflowPromptModifier,
  WorkflowPromptModifiers,
  WorkflowSkillModifier,
} from '../src/index.js';

const emptyModifiers = [] as const satisfies WorkflowPromptModifiers;
const oneSkill = [{ kind: 'skill', name: 'review' }] as const satisfies WorkflowPromptModifiers;
const severalSkills = [
  { kind: 'skill', name: 'review' },
  { kind: 'skill', name: 'test' },
] as const satisfies WorkflowPromptModifiers;
const skillArray: readonly WorkflowSkillModifier[] = [
  { kind: 'skill', name: 'review' },
  { kind: 'skill', name: 'test' },
];
const oneCommand = [
  { kind: 'command', name: 'isagi-docs' },
] as const satisfies WorkflowPromptModifiers;

const modifierOnly = { modifiers: severalSkills } satisfies WorkflowPromptInput;
const promptOnly = { prompt: 'Review this change.' } satisfies WorkflowPromptInput;

const broadModifiers: WorkflowPromptModifier[] = [{ kind: 'skill', name: 'review' }];

function acceptModifiers(_modifiers: WorkflowPromptModifiers): void {}

acceptModifiers(emptyModifiers);
acceptModifiers(oneSkill);
acceptModifiers(severalSkills);
acceptModifiers(skillArray);
acceptModifiers(oneCommand);

// @ts-expect-error A command cannot be combined with a skill.
acceptModifiers([
  { kind: 'skill', name: 'review' },
  { kind: 'command', name: 'run' },
]);

// @ts-expect-error Multiple commands are not a valid modifier collection.
acceptModifiers([
  { kind: 'command', name: 'first' },
  { kind: 'command', name: 'second' },
]);

// @ts-expect-error The broad union array does not prove that every item is a skill.
acceptModifiers(broadModifiers);

type SpawnAgentSessionInput = Parameters<OperationContext['spawnAgentSession']>[0];
type SendAgentPromptInput = Parameters<OperationContext['sendAgentPrompt']>[0];
type RunHeadlessAgentInput = Parameters<OperationContext['runHeadlessAgent']>[0];
type WorkflowInvocationKind = OperationContext['invocation']['kind'];

const spawnWithModifiers = {
  harness: 'codex',
  modifiers: oneCommand,
} satisfies SpawnAgentSessionInput;

const sendWithPrompt = {
  agentSessionId: 1,
  prompt: 'Continue.',
} satisfies SendAgentPromptInput;

const sendWithModifiers = {
  agentSessionId: 1,
  modifiers: oneSkill,
} satisfies SendAgentPromptInput;

const headlessWithPromptAndModifiers = {
  harness: 'pi',
  prompt: 'Inspect the repository.',
  modifiers: severalSkills,
} satisfies RunHeadlessAgentInput;

const commandModifier = {
  kind: 'command',
  name: 'isagi-docs',
} satisfies WorkflowCommandModifier;

const retryInvocation = 'retry' satisfies WorkflowInvocationKind;

void modifierOnly;
void promptOnly;
void spawnWithModifiers;
void sendWithPrompt;
void sendWithModifiers;
void headlessWithPromptAndModifiers;
void commandModifier;
void retryInvocation;
