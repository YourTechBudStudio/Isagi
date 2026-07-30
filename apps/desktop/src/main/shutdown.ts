import { Effect } from 'effect';

import type { RuntimeLifecycle } from './runtime-process/index.js';
import type { DesktopUpdaterService } from './updater/index.js';

export function stopDesktopServices(
  desktopUpdater: DesktopUpdaterService | undefined,
  runtimeLifecycle: Pick<RuntimeLifecycle, 'stop'>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (desktopUpdater) yield* desktopUpdater.stop();
    yield* runtimeLifecycle.stop();
  });
}
