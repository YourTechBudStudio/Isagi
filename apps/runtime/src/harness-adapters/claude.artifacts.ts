import { commandHookSource, shellQuote } from './artifacts.common.js';

export function claudeHookSource() {
  return commandHookSource('claude');
}

export function claudeSettings(hookPath: string) {
  const hook = {
    type: 'command',
    command: `node ${shellQuote(hookPath)}`,
    timeout: 2,
  } as const;
  const hookEntry = { hooks: [hook] } as const;
  return {
    hooks: {
      UserPromptSubmit: [hookEntry],
      Notification: [{ matcher: 'idle_prompt', hooks: [hook] }],
      Stop: [hookEntry],
    },
  };
}
