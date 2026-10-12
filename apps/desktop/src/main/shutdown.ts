export type DesktopExitDisposition =
  | { readonly kind: 'ordinary'; readonly code: number }
  | { readonly kind: 'install_update'; readonly install: () => void };

/**
 * Electron's quit protocol: which exit wins, and the order of the steps that end the process. It is not operational
 * work, so it stays a plain class; the services it ends are torn down by disposing the desktop runtime.
 */
export class DesktopShutdownCoordinator {
  readonly #dispose: () => Promise<void>;
  readonly #destroyRenderer: () => void;
  readonly #exit: (code: number) => void;
  readonly #diagnoseInstallRejection: () => void | Promise<void>;
  #disposition: DesktopExitDisposition | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #installHandoffStarted = false;

  constructor(dependencies: {
    /**
     * Disposes the desktop runtime: the updater stops, then the runtime process. Disposing a runtime that never built
     * (a quit before the app was ready) has nothing to stop.
     */
    readonly dispose: () => Promise<void>;
    readonly destroyRenderer: () => void;
    readonly exit: (code: number) => void;
    readonly diagnoseInstallRejection: () => void | Promise<void>;
  }) {
    this.#dispose = dependencies.dispose;
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
    await this.#dispose();
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
 * Main's `whenReady` sequence: build the desktop runtime, then open the first window, each only while no quit has been
 * requested. A quit can land while the build is in flight: shutdown disposes the runtime under it (the build settles
 * without a value), and opening the window then would run on the disposed runtime, fail with "ManagedRuntime
 * disposed", and turn an ordinary quit into exit code 1 through the startup failure path.
 */
export async function startDesktop(steps: {
  readonly isExitRequested: () => boolean;
  readonly build: () => Promise<void>;
  readonly openWindow: () => Promise<unknown>;
}) {
  if (steps.isExitRequested()) return;
  await steps.build();
  if (steps.isExitRequested()) return;
  await steps.openWindow();
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
