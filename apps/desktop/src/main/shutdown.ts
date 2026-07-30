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

export type DesktopExitDisposition =
  | { readonly kind: 'ordinary'; readonly code: number }
  | { readonly kind: 'install_update'; readonly install: () => void };

export class DesktopShutdownCoordinator {
  readonly #desktopUpdater: () => DesktopUpdaterService | undefined;
  readonly #runtimeLifecycle: Pick<RuntimeLifecycle, 'stop'>;
  readonly #destroyRenderer: () => void;
  readonly #exit: (code: number) => void;
  readonly #diagnoseInstallRejection: () => void | Promise<void>;
  #disposition: DesktopExitDisposition | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #installHandoffStarted = false;

  constructor(dependencies: {
    readonly desktopUpdater: () => DesktopUpdaterService | undefined;
    readonly runtimeLifecycle: Pick<RuntimeLifecycle, 'stop'>;
    readonly destroyRenderer: () => void;
    readonly exit: (code: number) => void;
    readonly diagnoseInstallRejection: () => void | Promise<void>;
  }) {
    this.#desktopUpdater = dependencies.desktopUpdater;
    this.#runtimeLifecycle = dependencies.runtimeLifecycle;
    this.#destroyRenderer = dependencies.destroyRenderer;
    this.#exit = dependencies.exit;
    this.#diagnoseInstallRejection = dependencies.diagnoseInstallRejection;
  }

  get committed() {
    return this.#disposition !== undefined;
  }

  /**
   * True once the installer has been handed the process. From that point the
   * quit sequence the installer starts is the terminal one and must be allowed
   * to run to completion.
   */
  get installHandoffStarted() {
    return this.#installHandoffStarted;
  }

  request(disposition: DesktopExitDisposition) {
    if (!this.#disposition) {
      this.#disposition = disposition;
      this.#destroyRenderer();
      this.#shutdownPromise = this.#shutdown();
    } else if (
      this.#disposition.kind === 'ordinary' &&
      disposition.kind === 'ordinary' &&
      this.#disposition.code === 0 &&
      disposition.code !== 0
    ) {
      this.#disposition = disposition;
    }
    return this.#shutdownPromise ?? Promise.resolve();
  }

  async #shutdown() {
    await Effect.runPromise(stopDesktopServices(this.#desktopUpdater(), this.#runtimeLifecycle));
    const disposition = this.#disposition;
    if (!disposition) return;
    if (disposition.kind === 'ordinary') {
      this.#exit(disposition.code);
      return;
    }
    this.#installHandoffStarted = true;
    try {
      disposition.install();
    } catch {
      this.#installHandoffStarted = false;
      await Promise.resolve(this.#diagnoseInstallRejection()).catch(() => undefined);
      this.#exit(1);
    }
  }
}

/**
 * The Electron `before-quit` policy, kept next to the coordinator that owns the
 * exit disposition so the decision is testable without the Electron app object.
 *
 * An ordinary quit is intercepted so coordinated shutdown can run first. The
 * installer's own quit sequence re-enters `before-quit`, and preventing that one
 * would strand a windowless, runtime-stopped process instead of installing and
 * relaunching, so it is allowed to terminate.
 */
export function handleBeforeQuit(
  event: { readonly preventDefault: () => void },
  coordinator: Pick<DesktopShutdownCoordinator, 'committed' | 'installHandoffStarted'>,
  beginShutdown: () => void,
) {
  if (coordinator.installHandoffStarted) return;
  event.preventDefault();
  if (!coordinator.committed) beginShutdown();
}
