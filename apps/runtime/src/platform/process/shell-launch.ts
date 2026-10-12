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

/**
 * Why a `user_shell` launch ran its command directly instead. The caller logs it: this function is
 * pure, and only the caller knows what the launch is for.
 */
export type ShellLaunchFallback = 'unsupported_command_name';

export interface ShellLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Set when a `user_shell` launch fell back to running the command directly. */
  readonly fallback?: ShellLaunchFallback | undefined;
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

  // The shell script names the command unquoted, so only a plain name can go through the shell.
  if (!simpleShellCommandName.test(input.launch.command)) {
    return {
      command: input.launch.command,
      args: input.launch.args,
      fallback: 'unsupported_command_name',
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
