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
  return {
    hooks: {
      UserPromptSubmit: [hookEntry],
      Notification: [{ matcher: 'idle_prompt', hooks: [hook] }],
      Stop: [hookEntry],
      StopFailure: [hookEntry],
    },
  };
}
