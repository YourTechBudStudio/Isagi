import type { OpenWorktreeOutput } from '@isagi/contracts';

export type WorktreeSetupFailure = Extract<OpenWorktreeOutput, { status: 'created_setup_failed' }>;

export function formatWorktreeSetupFailureDetails(
  setup: Extract<WorktreeSetupFailure['setup'], { status: 'failed' }>,
) {
  // Command hooks read like the terminal: the invocation, its merged
  // stdout+stderr output, then the exit summary (`message`) as a footer.
  if (setup.failedHookType === 'command') {
    const output = setup.outputExcerpt?.trim();
    return [setup.command ? `$ ${setup.command}` : null, output || null, setup.message]
      .filter((section): section is string => Boolean(section))
      .join('\n\n');
  }

  // Copy/symlink hooks have no command output — just the failure reason and the
  // paths involved.
  const locations = [
    setup.src ? `src: ${setup.src}` : null,
    setup.dest ? `dest: ${setup.dest}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
  return [setup.message, locations || null]
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
}
