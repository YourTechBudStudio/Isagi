import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type {
  LaunchPtyProcessInput,
  PtyForegroundCommandState,
  ShellIntegrationConfig,
} from '../types.js';

export type { ShellIntegrationConfig };

export type ShellIntegrationEvent = 'foreground-start' | 'foreground-end';

export interface ShellIntegrationLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly shellIntegration: ShellIntegrationConfig | null;
}

// The OSC marker is the single wire format shared between the shell rc scripts
// (emitters) and the stream parser (consumer). Keep the code/namespace defined
// once here so the emit and parse halves can never drift apart.
const markerOscCode = '6973';
const markerNamespace = 'isagi';
const markerPrefix = `\x1b]${markerOscCode};${markerNamespace};`;
const markerTerminator = '\x07';
// `printf` interprets octal escapes, so the shell-side format uses \033/\007
// rather than the literal control bytes above. Same sequence, different encoding.
const markerPrintfFormat = `\\033]${markerOscCode};${markerNamespace};%s;%s\\007`;
const maxBufferedMarkerBytes = 512;

/** The single mapping from a marker event to foreground-command state, shared by all backends. */
export function foregroundStateFromEvent(event: ShellIntegrationEvent): PtyForegroundCommandState {
  return event === 'foreground-start' ? 'working' : 'idle';
}

export function prepareShellIntegration(input: {
  readonly launch: LaunchPtyProcessInput;
  readonly ptyProcessId: number;
  readonly sessionsPath: string;
  readonly env: NodeJS.ProcessEnv;
}): ShellIntegrationLaunch {
  // Launching the shell without the working-state signal is always a valid
  // outcome — a terminal with no attention dot beats no terminal at all.
  const passthrough: ShellIntegrationLaunch = {
    command: input.launch.command,
    args: input.launch.args,
    env: input.env,
    shellIntegration: null,
  };

  if (!input.launch.shellIntegration) return passthrough;

  const shell = shellName(input.launch.command);
  if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') return passthrough;

  const token = randomBytes(16).toString('hex');
  const directory = join(input.sessionsPath, 'shell-integration', String(input.ptyProcessId));

  // Shell integration is best-effort: a read-only sessions dir, full disk, or
  // permission failure must degrade to a plain shell rather than fail the launch.
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });

    if (shell === 'bash') {
      const rcfile = join(directory, 'bashrc');
      writeFileSync(rcfile, bashRc(token), { mode: 0o600 });
      return {
        command: input.launch.command,
        args: ['--rcfile', rcfile, '-i', ...input.launch.args],
        env: { ...input.env, ISAGI_SHELL_INTEGRATION: '1' },
        shellIntegration: { token },
      };
    }

    if (shell === 'zsh') {
      const zdotdir = directory;
      writeFileSync(join(zdotdir, '.zshrc'), zshRc(token), { mode: 0o600 });
      return {
        command: input.launch.command,
        args: input.launch.args,
        env: {
          ...input.env,
          ISAGI_SHELL_INTEGRATION: '1',
          ISAGI_ORIGINAL_ZDOTDIR: input.env.ZDOTDIR ?? input.env.HOME,
          ZDOTDIR: zdotdir,
        },
        shellIntegration: { token },
      };
    }

    const initFile = join(directory, 'config.fish');
    writeFileSync(initFile, fishInit(token), { mode: 0o600 });
    return {
      command: input.launch.command,
      args: ['--init-command', `source ${fishQuote(initFile)}`, ...input.launch.args],
      env: { ...input.env, ISAGI_SHELL_INTEGRATION: '1' },
      shellIntegration: { token },
    };
  } catch {
    return passthrough;
  }
}

export function shellIntegrationTokenFromRef(ref: {
  readonly shellIntegrationToken?: string | null | undefined;
}): ShellIntegrationConfig | null {
  return ref.shellIntegrationToken ? { token: ref.shellIntegrationToken } : null;
}

// The token is the per-process secret that prevents arbitrary program output
// from spoofing the foreground signal. It is persisted into the (runtime-internal)
// backend-ref column so tmux replay can strip markers after a runtime restart;
// it is never surfaced over a client/API contract.
export function refWithShellIntegrationToken<T extends object>(
  ref: T,
  shellIntegration: ShellIntegrationConfig | null,
): T & { readonly shellIntegrationToken?: string | null } {
  if (!shellIntegration) return ref;
  return { ...ref, shellIntegrationToken: shellIntegration.token };
}

export function createShellIntegrationParser(input: {
  readonly shellIntegration: ShellIntegrationConfig | null;
  readonly onEvent?: ((event: ShellIntegrationEvent) => void) | undefined;
}) {
  if (!input.shellIntegration) {
    return {
      push: (data: string) => data,
      flush: () => '',
    };
  }

  let buffer = '';
  const token = input.shellIntegration.token;

  const handleMarker = (body: string) => {
    const [event, markerToken] = body.split(';');
    if (markerToken !== token) return;
    if (event === 'foreground-start' || event === 'foreground-end') {
      input.onEvent?.(event);
    }
  };

  return {
    push: (data: string) => {
      buffer += data;
      let visible = '';

      while (buffer.length > 0) {
        const start = buffer.indexOf(markerPrefix);
        if (start === -1) {
          const retained = longestSuffixPrefixLength(buffer, markerPrefix);
          visible += buffer.slice(0, buffer.length - retained);
          buffer = buffer.slice(buffer.length - retained);
          break;
        }

        visible += buffer.slice(0, start);
        const markerEnd = buffer.indexOf(markerTerminator, start + markerPrefix.length);
        if (markerEnd === -1) {
          buffer = buffer.slice(start);
          if (buffer.length > maxBufferedMarkerBytes) {
            visible += buffer;
            buffer = '';
          }
          break;
        }

        handleMarker(buffer.slice(start + markerPrefix.length, markerEnd));
        buffer = buffer.slice(markerEnd + markerTerminator.length);
      }

      return visible;
    },
    flush: () => {
      const visible = buffer;
      buffer = '';
      return visible;
    },
  };
}

export function stripShellIntegrationMarkers(
  data: string,
  shellIntegration: ShellIntegrationConfig | null,
) {
  const parser = createShellIntegrationParser({ shellIntegration });
  return parser.push(data) + parser.flush();
}

function shellName(command: string) {
  return basename(command).replace(/^-/, '');
}

function markerPrintf(shellVariable: string) {
  return `printf '${markerPrintfFormat}' "$1" "${shellVariable}"`;
}

function bashRc(token: string) {
  return `# Isagi ephemeral terminal integration. This file is generated per terminal process.
if [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

__isagi_token=${shellQuote(token)}
__isagi_command_running=0

__isagi_marker() {
  ${markerPrintf('$__isagi_token')}
}

__isagi_preexec() {
  case "$BASH_COMMAND" in
    __isagi_*|*__isagi_prompt_command*|*__isagi_preexec*) return ;;
  esac
  if [ "\${__isagi_command_running:-0}" = 0 ]; then
    __isagi_command_running=1
    __isagi_marker foreground-start
  fi
}

__isagi_prompt_command() {
  local __isagi_status=$?
  trap - DEBUG
  if [ "\${__isagi_command_running:-0}" = 1 ]; then
    __isagi_marker foreground-end
    __isagi_command_running=0
  else
    __isagi_marker foreground-end
  fi
  if [ -n "\${__isagi_original_prompt_command:-}" ]; then
    eval "$__isagi_original_prompt_command"
  fi
  trap '__isagi_preexec' DEBUG
  return $__isagi_status
}

__isagi_original_prompt_command=\${PROMPT_COMMAND:-}
trap '__isagi_preexec' DEBUG
PROMPT_COMMAND=__isagi_prompt_command
`;
}

function zshRc(token: string) {
  return `# Isagi ephemeral terminal integration. This file is generated per terminal process.
if [ -n "$ISAGI_ORIGINAL_ZDOTDIR" ] && [ -r "$ISAGI_ORIGINAL_ZDOTDIR/.zshrc" ]; then
  source "$ISAGI_ORIGINAL_ZDOTDIR/.zshrc"
elif [ -r "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc"
fi

autoload -Uz add-zsh-hook
__isagi_token=${shellQuote(token)}

__isagi_marker() {
  ${markerPrintf('$__isagi_token')}
}

__isagi_preexec() {
  __isagi_marker foreground-start
}

__isagi_precmd() {
  __isagi_marker foreground-end
}

add-zsh-hook preexec __isagi_preexec
add-zsh-hook precmd __isagi_precmd
`;
}

function fishInit(token: string) {
  return `# Isagi ephemeral terminal integration. This file is generated per terminal process.
set -g __isagi_token ${fishQuote(token)}

function __isagi_marker
  command printf '${markerPrintfFormat}' $argv[1] $__isagi_token
end

function __isagi_preexec --on-event fish_preexec
  __isagi_marker foreground-start
end

function __isagi_postexec --on-event fish_postexec
  __isagi_marker foreground-end
end
`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fishQuote(value: string) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function longestSuffixPrefixLength(value: string, prefix: string) {
  const max = Math.min(value.length, prefix.length - 1);
  for (let length = max; length > 0; length--) {
    if (value.slice(value.length - length) === prefix.slice(0, length)) {
      return length;
    }
  }
  return 0;
}
