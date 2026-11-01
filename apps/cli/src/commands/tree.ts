/**
 * The `isagi` command tree: `serve` at the root and every client command under `workflows`.
 *
 * The tree is the one source for parsing, help and `checkCommandLine`; `commandCatalog` is built by
 * the same `group`/`clientCommand` calls, so it cannot drift from it.
 */
import { Command, Flag } from 'effect/cli';

import { CommandRunner, type CatalogEntry } from './define.js';
import { workflowsGroup } from './workflows.js';

const serveCommand = Command.make(
  'serve',
  {
    host: Flag.String('host').pipe(
      Flag.withMetavar('address'),
      Flag.withDescription(
        'Listen address; overrides ISAGI_HOST and config.yaml server.host. Defaults to 127.0.0.1; 0.0.0.0 listens on every interface.',
      ),
      Flag.optional,
    ),
    port: Flag.String('port').pipe(
      Flag.withMetavar('0-65535'),
      Flag.withDescription(
        'Listen port; overrides ISAGI_PORT and config.yaml server.port. Defaults to 0, a free port chosen at start.',
      ),
      Flag.optional,
    ),
    dataDir: Flag.String('data-dir').pipe(
      Flag.withMetavar('path'),
      Flag.withDescription('Data directory; overrides ISAGI_DATA_DIR. Defaults to ~/.isagi.'),
      Flag.optional,
    ),
    webRoot: Flag.String('web-root').pipe(
      Flag.withMetavar('path'),
      Flag.withDescription(
        'Directory of the web workbench build, served when config.yaml server.serveWebUi is true. Defaults to the copy bundled with isagi.',
      ),
      Flag.optional,
    ),
    allowedOrigins: Flag.String('allowed-origins').pipe(
      Flag.withMetavar('origin,…'),
      Flag.withDescription(
        'Browser origins allowed to call the runtime, comma-separated (http://localhost:5173, file://). Clients without an origin are always allowed.',
      ),
      Flag.optional,
    ),
  },
  (flags) => CommandRunner.use((runner) => runner.serve(flags)),
).pipe(
  Command.withDescription(
    'Run the Isagi runtime in this process until it is stopped. Prints ISAGI_RUNTIME_READY <url> once it listens. With --json, only a failure before the runtime starts is a JSON document.',
  ),
  Command.withShortDescription('Run the Isagi runtime in this process.'),
  Command.withExamples([
    { command: 'isagi serve', description: 'Loopback on a free port, data in ~/.isagi' },
    { command: 'isagi serve --port 11299', description: 'A fixed port to return to' },
    {
      command: 'isagi serve --host 0.0.0.0 --data-dir ~/isagi-server',
      description: 'Every interface, with its own data directory',
    },
  ]),
);

/** The root command. Without a command after it, a usage error listing `serve` and `workflows`. */
export const isagi = Command.make('isagi').pipe(
  Command.withDescription(
    'Isagi: run the runtime (`isagi serve`) or work with its workflows (`isagi workflows`).',
  ),
  Command.withExamples([
    { command: 'isagi serve', description: 'Run a runtime' },
    {
      command: 'isagi workflows runs list --json',
      description: 'List runs of the runtime this terminal belongs to',
    },
  ]),
  Command.withSubcommands([serveCommand, workflowsGroup.command]),
);

/**
 * Every node, with its words in `ShowHelp.commandPath` form (root included): ['isagi'],
 * ['isagi', 'serve'], ['isagi', 'workflows'], ['isagi', 'workflows', 'runs', 'list'], …
 */
export const commandCatalog: ReadonlyArray<CatalogEntry> = [
  { path: ['isagi'], stdout: 'json' },
  { path: ['isagi', 'serve'], stdout: 'json' },
  ...workflowsGroup.catalog.map((entry) => ({
    path: ['isagi', ...entry.path],
    stdout: entry.stdout,
  })),
];

/** Whether `path` names a raw-output command (`workflows checkpoints read`); a group or unknown path is not. */
export function isRawCommand(path: ReadonlyArray<string>): boolean {
  return commandCatalog.some(
    (entry) =>
      entry.stdout === 'raw' &&
      entry.path.length === path.length &&
      entry.path.every((word, index) => word === path[index]),
  );
}
