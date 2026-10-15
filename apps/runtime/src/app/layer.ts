import { Layer } from 'effect';

import { CliAccessLayer } from '../cli-access/index.js';
import { CommandsLayer } from '../commands/index.js';
import { EditorLayer } from '../editor/index.js';
import { EnvironmentLayer, HarnessObservationTargetsLayer } from '../environment/index.js';
import { FluidcastLayer } from '../fluidcast/index.js';
import { HarnessesLayer } from '../harnesses/index.js';
import { EventLoopWatchdog } from '../platform/diagnostics/index.js';
import { EventsLayer } from '../platform/events/index.js';
import { DataDirectory, RuntimeDatabase } from '../platform/persistence/index.js';
import { UserShell } from '../platform/process/index.js';
import { ProjectsLayer } from '../projects/index.js';
import { PtyProcessesLayer } from '../pty-processes/index.js';
import { RuntimeConfig } from '../runtime-config/index.js';
import { WorkflowProjectErasure, WorkflowsLayer } from '../workflows/index.js';
import { StateFile, WorkspaceLayer } from '../workspace/index.js';

/**
 * The services every module layer leaves open: they read the process environment or own a process-wide handle, and
 * tests always replace them. Provided exactly once, here.
 */
export const PlatformLayer = Layer.mergeAll(
  RuntimeDatabase.layer,
  StateFile.layer,
  RuntimeConfig.layer,
  UserShell.layer,
).pipe(Layer.provideMerge(DataDirectory.layer));

/**
 * Every module's layer, merged. Each service's own `layer` wires its module dependencies by reference, and a layer is
 * built once per reference for the whole build, so a service several modules depend on (the event buses, the entity
 * lock, the harness observer) is one instance. The platform and the two ports stay open.
 */
export const ModulesLayer = Layer.mergeAll(
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
 * The whole runtime service graph. The `satisfies` proves it closed: a module service whose requirement is neither
 * wired by its own `layer`, a platform service nor a port is a compile error here.
 */
export const AppLayer = ModulesLayer.pipe(
  Layer.provide(PortsLayer),
  Layer.provideMerge(PlatformLayer),
) satisfies Layer.Layer<never, unknown, never>;

/** Every service the routes and startup can use. */
export type RuntimeServices = Layer.Success<typeof AppLayer>;
