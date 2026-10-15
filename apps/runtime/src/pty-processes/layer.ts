import { Layer } from 'effect';

import { PtyForegroundState } from './foreground-state.js';
import { LaunchEnvironment } from './launch-environment.js';
import { PtyService } from './service.js';

/** The pty-processes module's public services. Each service's `layer` wires its own module dependencies. */
export const PtyProcessesLayer = Layer.mergeAll(
  PtyService.layer,
  PtyForegroundState.layer,
  LaunchEnvironment.layer,
);
