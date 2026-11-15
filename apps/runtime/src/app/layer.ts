import { Layer } from 'effect';

import { AccessLayer, type LauncherToken } from '../access/index.js';
import { CliAccessLayer, type CliEntry } from '../cli-access/index.js';
import { CommandsLayer } from '../commands/index.js';
import { EditorLayer } from '../editor/index.js';
import { EnvironmentLayer, HarnessObservationTargetsLayer } from '../environment/index.js';
import { FluidcastLayer } from '../fluidcast/index.js';
import { HarnessesLayer } from '../harnesses/index.js';
import { EventLoopWatchdog } from '../platform/diagnostics/index.js';
import { EventsLayer } from '../platform/events/index.js';
import {
  DataDirectory,
  type DataDirectoryRoot,
  RuntimeDatabase,
} from '../platform/persistence/index.js';
import { UserShell } from '../platform/process/index.js';
import { ProjectsLayer } from '../projects/index.js';
import { PtyProcessesLayer } from '../pty-processes/index.js';
import { RuntimeConfig } from '../runtime-config/index.js';
import { WorkflowProjectErasure, WorkflowsLayer } from '../workflows/index.js';
import { StateFile, WorkspaceLayer } from '../workspace/index.js';

/**
 * The services every module layer leaves open: they own a process-wide handle or the data root, and tests always
 * replace them. Provided exactly once, here; the data root itself comes from the launch (`DataDirectoryRoot`).
 *
 * `userShell` is the one platform service a booted test runtime swaps: the live layer runs the developer's login shell
 * (`platform/process/testing.ts` has the stand-in).
 */
export function platformLayer(userShell: Layer.Layer<UserShell>) {
  return Layer.mergeAll(
    RuntimeDatabase.layer,
    StateFile.layer,
    RuntimeConfig.layer,
    userShell,
  ).pipe(Layer.provideMerge(DataDirectory.layer));
}

export const PlatformLayer = platformLayer(UserShell.layer);

/**
 * Every module's layer, merged. Each service's own `layer` wires its module dependencies by reference, and a layer is
 * built once per reference for the whole build, so a service several modules depend on (the event buses, the entity
 * lock, the harness observer) is one instance. The platform and the two ports stay open.
 */
export const ModulesLayer = Layer.mergeAll(
  AccessLayer,
  CliAccessLayer,
  ProjectsLayer,
  PtyProcessesLayer,
  CommandsLayer,
  EditorLayer,
  HarnessesLayer,
  FluidcastLayer,
  EnvironmentLayer,
  WorkspaceLayer,
  WorkflowsLayer,
  EventsLayer,
  EventLoopWatchdog.layer,
);

/**
 * The two ports a lower module owns and a higher module implements: project deletion erases workflow runs inside the
 * workspace's transaction, and the harness observer reads its targets from the environment's agent sessions.
 */
export const PortsLayer = Layer.mergeAll(WorkflowProjectErasure, HarnessObservationTargetsLayer);

/**
 * The whole runtime service graph. The `satisfies` proves it closed apart from the three launch inputs a lower module
 * reads (`launchInputsLayer` provides them): a module service whose requirement is neither wired by its own `layer`,
 * a platform service, a port nor a launch input is a compile error here.
 */
export const AppLayer = appLayer(PlatformLayer) satisfies Layer.Layer<
  never,
  unknown,
  DataDirectoryRoot | CliEntry | LauncherToken
>;

/** Every module over `platform`: `AppLayer` with the live platform, or a test runtime's `platformLayer(...)`. */
export function appLayer(platform: ReturnType<typeof platformLayer>) {
  return ModulesLayer.pipe(Layer.provide(PortsLayer), Layer.provideMerge(platform));
}

/** Every service the routes and startup can use. */
export type RuntimeServices = Layer.Success<typeof AppLayer>;
