import { useAtom, useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';

import { signedOutAtom } from '../../lib/auth/state.js';
import { deriveStartupGate } from '../../lib/control-plane/launchability.js';
import { controlPlaneAtom } from '../../lib/control-plane/queries.js';
import { hasDesktopHost } from '../../lib/desktop-bridge.js';
import { makeRetryEditorProvisioningAtom } from '../../lib/editor/queries.js';
import { DURATION, EASE_EXPO } from '../../lib/motion.js';
import { RuntimeLocalityContext, deriveRuntimeLocality } from '../../lib/runtime/locality.js';
import { disabledQuery } from '../../lib/state/policy.js';
import { useRegistry } from '../../lib/state/registry.js';
import { WorkspacePage } from '../workspace/WorkspacePage.js';
import { OnboardingFlow } from './OnboardingFlow.js';
import { SignedOutSurface } from './SignedOutSurface.js';
import { startupBootView } from './startup-view.js';
import { BootSurface } from './StartupSurfaces.js';

/**
 * The single route into the workspace. It renders `WorkspacePage` — and therefore
 * mounts every workspace hook, subscription, and the command palette — only once
 * the runtime's control plane reports completed onboarding.
 *
 * Everything before that is one persistent `BootSurface`: the gate maps its
 * query/snapshot state to a `BootView` and lets the surface morph between states
 * instead of swapping screens. When the gate opens, the workspace mounts beneath
 * the splash immediately and the splash plays its one-time exit — track complete,
 * a short hold, then a room-scale fade. The overlay never intercepts input.
 *
 * The onboarding branch is sticky: `onboardingHeld` keeps the flow mounted after a
 * policy is committed so the reconciliation results survive the snapshot flipping
 * to complete; only the explicit Continue (`onComplete`) releases it.
 *
 * It is also where runtime locality is derived and provided: the desktop bridge's
 * presence is fixed for the page's life, so the value is known before anything
 * mounts. Only `WorkspacePage` is wrapped: locality decides whether a command's
 * URL is worth offering, which is a question the boot, onboarding, and failure
 * surfaces never ask.
 *
 * The page never waits on the desktop: the desktop loads this page only once its
 * runtime is ready, and shows its own failure page when that runtime fails.
 *
 * First comes the signed-out branch: once the runtime has
 * answered 401 (`signedOutAtom`), the gate stops reading and shows the sign-in
 * view, or the expiry screen first if the workbench was showing on this page.
 * Unmounting the workspace there also closes its socket and queries, so nothing
 * keeps retrying against a runtime that has refused the page.
 */
export function StartupGate() {
  const registry = useRegistry();
  const signedOut = useAtomValue(signedOutAtom);
  // Once the runtime has refused this page, the gate reads nothing (the old `enabled: false`); a
  // mounted read would keep earning 401s on every focus revalidation.
  const controlPlane = useAtomValue(signedOut ? disabledQuery : controlPlaneAtom);
  const retryProvisioningAtom = useMemo(makeRetryEditorProvisioningAtom, []);
  const [retryProvisioning, runRetryProvisioning] = useAtom(retryProvisioningAtom);
  const [onboardingHeld, setOnboardingHeld] = useState(false);
  const [splashDone, setSplashDone] = useState(false);

  const snapshot = Option.getOrUndefined(AsyncResult.value(controlPlane));
  const gate = snapshot ? deriveStartupGate(snapshot) : null;
  // Ahead of onboarding, boot views and the workspace (and its opening splash): unmounting the
  // workspace here closes its socket and queries.
  if (signedOut) {
    return <SignedOutSurface />;
  }

  if (snapshot && (gate?.kind === 'onboarding' || onboardingHeld)) {
    return (
      <OnboardingFlow
        snapshot={snapshot}
        onCommitted={() => setOnboardingHeld(true)}
        onComplete={() => setOnboardingHeld(false)}
      />
    );
  }

  const view = startupBootView({
    controlPlane,
    retryProvisioning,
    // Not `useAtomRefresh`: that would mount the read while the page is signed out.
    onRetry: () => registry.refresh(controlPlaneAtom),
    onRetryProvisioning: () => runRetryProvisioning(),
  });

  if (view) {
    return <BootSurface view={view} />;
  }

  return (
    <>
      <RuntimeLocalityContext.Provider
        value={deriveRuntimeLocality({
          hosted: hasDesktopHost(),
          browserLocalAssertion: import.meta.env.VITE_ISAGI_RUNTIME_LOCAL,
        })}
      >
        <WorkspacePage />
      </RuntimeLocalityContext.Provider>
      {!splashDone ? (
        // The one-time exit: the completed track holds a beat, then the whole
        // splash eases out at room scale while the workspace fades in beneath.
        <motion.div
          className="pointer-events-none fixed inset-0 z-50"
          initial={{ opacity: 1, scale: 1 }}
          animate={{ opacity: 0, scale: 0.985 }}
          transition={{ delay: 0.3, duration: DURATION.room, ease: EASE_EXPO }}
          onAnimationComplete={() => setSplashDone(true)}
        >
          <BootSurface view={{ kind: 'opening' }} />
        </motion.div>
      ) : null}
    </>
  );
}
