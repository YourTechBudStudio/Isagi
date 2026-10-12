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
 * The user's environment with the runtime's own controls removed (`ISAGI_*`, `HOST`, `PORT`,
 * Electron's Node switch and the web dev URL), so a process the user launches never inherits the
 * runtime's identity, plus the terminal capabilities every PTY advertises.
 */
export function userShellBaseEnv(environment: NodeJS.ProcessEnv = process.env) {
  const sanitized: NodeJS.ProcessEnv = {
    ...environment,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  for (const key of Object.keys(sanitized)) {
    if (key.startsWith('ISAGI_')) delete sanitized[key];
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
