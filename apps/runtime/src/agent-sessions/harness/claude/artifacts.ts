import { commandHookSource, shellQuote } from '../ledger.common.js';

export function claudeHookSource() {
  return commandHookSource('claude');
}

export function claudeSettings(input: { readonly hookPath: string }) {
  const hook = {
    type: 'command',
    command: `node ${shellQuote(input.hookPath)}`,
    timeout: 2,
  } as const;
  const hookEntry = { hooks: [hook] } as const;
  const askUserQuestionEntry = { matcher: 'AskUserQuestion', hooks: [hook] } as const;
  return {
    hooks: {
      UserPromptSubmit: [hookEntry],
      PreToolUse: [askUserQuestionEntry],
      PostToolUse: [askUserQuestionEntry],
      PostToolUseFailure: [askUserQuestionEntry],
      Stop: [hookEntry],
      StopFailure: [hookEntry],
    },
  };
}
