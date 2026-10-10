import { basename } from 'node:path';
import process from 'node:process';

/**
 * How a process is started: `direct` executes the command as given; `user_shell` runs it through
 * the user's login/interactive shell so their rc files shape `PATH` and aliases.
 */
export type ShellLaunchMode = 'direct' | 'user_shell';

export interface ShellLaunchInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly launchMode?: ShellLaunchMode | undefined;
}

export interface ShellLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

const simpleShellCommandName = /^[A-Za-z0-9._-]+$/;

export function shellLaunchCommand(input: {
  readonly launch: ShellLaunchInput;
  readonly env: NodeJS.ProcessEnv;
}): ShellLaunchCommand {
  const mode: ShellLaunchMode = input.launch.launchMode ?? 'direct';
  if (mode === 'direct') {
    return {
      command: input.launch.command,
      args: input.launch.args,
    };
  }

  if (!simpleShellCommandName.test(input.launch.command)) {
    console.warn('[runtime] User-shell PTY launch fell back to direct command', {
      command: input.launch.command,
      reason: 'unsupported_command_name',
    });
    return {
      command: input.launch.command,
      args: input.launch.args,
    };
  }

  const shell = input.env.SHELL || process.env.SHELL || 'bash';
  const shellName = basename(shell).replace(/^-/, '');
  const script = `${input.launch.command} ${shellArgExpansion(shellName)}`;

  if (shellName === 'fish') {
    return {
      command: shell,
      args: ['--login', '--interactive', '--command', script, ...input.launch.args],
    };
  }

  if (shellName === 'bash') {
    return {
      command: shell,
      args: ['-ic', script, '--', ...input.launch.args],
    };
  }

  return {
    command: shell,
    args: ['-lic', script, '--', ...input.launch.args],
  };
}

function shellArgExpansion(shellName: string) {
  return shellName === 'fish' ? '$argv' : '"$@"';
}
