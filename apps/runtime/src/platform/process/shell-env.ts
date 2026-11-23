import { delimiter, dirname } from 'node:path';
import process from 'node:process';

/** The shell a new terminal runs when the user's environment names none. */
export function terminalShellCommand() {
  return process.env.SHELL || 'bash';
}

/**
 * The environment a user process is launched with: the sanitized user environment, with the
 * runtime's own Node on `PATH` so the `isagi` CLI shim and Node-based tools resolve.
 */
export function launchEnv(environment: NodeJS.ProcessEnv = process.env) {
  const sanitized = userShellBaseEnv(environment);
  return {
    ...sanitized,
    PATH: pathWithRuntimeNodeBin(sanitized.PATH),
  } satisfies NodeJS.ProcessEnv;
}

/**
 * Variables that name the terminal emulator or multiplexer the runtime was launched from. A PTY's terminal is Isagi's
 * xterm, so passing them through would lie to programs: TUIs read them to pick a clipboard path, and with `TMUX` or
 * `VTE_VERSION` set they copy into that other terminal instead of sending OSC 52 to the user's own clipboard. `SSH_*`,
 * `DISPLAY` and `WAYLAND_DISPLAY` are deliberately absent: they describe the host machine, not the terminal.
 */
const launchingTerminalIdentity = {
  names: new Set([
    'TMUX',
    'TMUX_PANE',
    'STY',
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'TERM_SESSION_ID',
    'LC_TERMINAL',
    'LC_TERMINAL_VERSION',
    'VTE_VERSION',
    'ITERM_SESSION_ID',
    'ITERM_PROFILE',
    'KITTY_WINDOW_ID',
    'KITTY_PID',
    'WT_SESSION',
    'WT_PROFILE_ID',
    'KONSOLE_VERSION',
    'XTERM_VERSION',
    'TERMINAL_EMULATOR',
    'GNOME_TERMINAL_SCREEN',
    'GNOME_TERMINAL_SERVICE',
  ]),
  /** `ZELLIJ` covers both `ZELLIJ` itself and every `ZELLIJ_*`. */
  prefixes: ['ZELLIJ', 'WEZTERM_', 'ALACRITTY_', 'GHOSTTY_', 'KONSOLE_DBUS_'],
} as const;

function isLaunchingTerminalIdentity(key: string) {
  return (
    launchingTerminalIdentity.names.has(key) ||
    launchingTerminalIdentity.prefixes.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * The user's environment with the runtime's own controls removed (`ISAGI_*`, `HOST`, `PORT`,
 * Electron's Node switch and the web dev URL), so a process the user launches never inherits the
 * runtime's identity, plus the terminal capabilities every PTY advertises, and never the identity of
 * the terminal or multiplexer that launched the runtime (see `launchingTerminalIdentity`).
 */
export function userShellBaseEnv(environment: NodeJS.ProcessEnv = process.env) {
  const sanitized: NodeJS.ProcessEnv = {
    ...environment,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  for (const key of Object.keys(sanitized)) {
    if (key.startsWith('ISAGI_') || isLaunchingTerminalIdentity(key)) delete sanitized[key];
  }
  delete sanitized.ELECTRON_RUN_AS_NODE;
  delete sanitized.HOST;
  delete sanitized.PORT;
  delete sanitized.VITE_ISAGI_RUNTIME_URL;
  return sanitized;
}

function pathWithRuntimeNodeBin(path: string | undefined) {
  const nodeBin = dirname(process.execPath);
  if (!path) return nodeBin;
  const entries = path.split(delimiter);
  return entries.includes(nodeBin) ? path : [nodeBin, ...entries].join(delimiter);
}
