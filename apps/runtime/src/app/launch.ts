import { Context, Layer } from 'effect';

import type { RuntimeLaunch, SourcedValue } from '@isagi/cli/serve-launch';

import { CliEntry } from '../cli-access/index.js';
import { DataDirectoryRoot } from '../platform/persistence/index.js';

/** The listening inputs from `serve`; read only by `HttpServerLayer`. */
export class ServerLaunch extends Context.Service<
  ServerLaunch,
  {
    /** Flag or environment; undefined means `config.yaml`, then the default. */
    readonly host: SourcedValue<string> | undefined;
    readonly port: SourcedValue<number> | undefined;
    /** Carried for the browser workbench; nothing reads it yet. */
    readonly webRoot: string | undefined;
    readonly allowedOrigins: readonly string[];
  }
>()('isagi/runtime/app/ServerLaunch') {}

/**
 * Splits the one launch `serve` handed over into the inputs each owner reads, so no lower module
 * sees `RuntimeLaunch` or a launch-wide value: the data root to persistence, the CLI file to
 * cli-access, and the listening inputs to the server.
 */
export function launchInputsLayer(
  launch: RuntimeLaunch,
): Layer.Layer<ServerLaunch | DataDirectoryRoot | CliEntry> {
  return Layer.mergeAll(
    Layer.succeed(ServerLaunch, {
      host: launch.host,
      port: launch.port,
      webRoot: launch.webRoot,
      allowedOrigins: launch.allowedOrigins,
    }),
    Layer.succeed(DataDirectoryRoot, { path: launch.dataDirectory.value }),
    Layer.succeed(CliEntry, { path: launch.cliEntryPath }),
  );
}
