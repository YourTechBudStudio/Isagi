import { basename } from 'node:path';
import process from 'node:process';

import type { LaunchPtyProcessInput, PtyLaunchMode } from '../types.js';

export interface BackendLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
}

const simpleShellCommandName = /^[A-Za-z0-9._-]+$/;

export function backendLaunchCommand(input: {
  readonly launch: LaunchPtyProcessInput;
  readonly env: NodeJS.ProcessEnv;
}): BackendLaunchCommand {
  const mode: PtyLaunchMode = input.launch.launchMode ?? 'direct';
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
