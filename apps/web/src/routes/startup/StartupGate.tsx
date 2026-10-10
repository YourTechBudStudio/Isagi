import { useAtom, useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';

import { deriveStartupGate } from '../../lib/control-plane/launchability.js';
import { controlPlaneAtom } from '../../lib/control-plane/queries.js';
import { makeRetryEditorProvisioningAtom } from '../../lib/editor/queries.js';
import { DURATION, EASE_EXPO } from '../../lib/motion.js';
import { RuntimeLocalityContext, deriveRuntimeLocality } from '../../lib/runtime/locality.js';
import { disabledQuery } from '../../lib/state/policy.js';
import { useRegistry } from '../../lib/state/registry.js';
import { WorkspacePage } from '../workspace/WorkspacePage.js';
import { hostRuntimeAllowsQueries, useHostRuntimeGate } from './HostRuntimeGate.js';
import { OnboardingFlow } from './OnboardingFlow.js';
import { startupBootView } from './startup-view.js';
import { BootSurface, type BootView } from './StartupSurfaces.js';

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
 * It is also where runtime locality is derived and provided. The gate already
 * holds the only authoritative input — the host's ownership snapshot — and it
 * already refuses to mount the workspace before that snapshot resolves, so no
 * workspace surface can observe a "still finding out" locality and no second
 * subscription is needed. Only `WorkspacePage` is wrapped: locality decides
 * whether a command's URL is worth offering, which is a question the boot,
 * onboarding, and failure surfaces never ask.
 */
export function StartupGate() {
  const host = useHostRuntimeGate();
  const registry = useRegistry();
  // While the host disallows queries the gate reads nothing (the old `enabled: false`).
  const controlPlane = useAtomValue(
    hostRuntimeAllowsQueries(host.decision) ? controlPlaneAtom : disabledQuery,
  );
  const retryProvisioningAtom = useMemo(makeRetryEditorProvisioningAtom, []);
  const [retryProvisioning, runRetryProvisioning] = useAtom(retryProvisioningAtom);
  const [onboardingHeld, setOnboardingHeld] = useState(false);
  const [splashDone, setSplashDone] = useState(false);

  const snapshot = Option.getOrUndefined(AsyncResult.value(controlPlane));
  const gate = snapshot ? deriveStartupGate(snapshot) : null;
  const hostView: BootView | null =
    host.decision === 'connecting'
      ? { kind: 'connecting' }
      : host.decision === 'failed'
        ? { kind: 'host_failed' }
        : null;

  // Host lifecycle facts outrank stale control-plane data. A managed runtime
  // failure remains blocked here only for the brief interval before Electron's
  // fatal-exit path closes the renderer.
  if (hostView) {
    return <BootSurface view={hostView} />;
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
    // Not `useAtomRefresh`: that would mount the read while the host still disallows it.
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
          hosted: host.hosted,
          snapshot: host.snapshot,
          // The build-time assertion is an operator's claim about a plain-browser
          // client. Withholding it when hosted makes the precedence visible here
          // rather than resting on the derivation ignoring it.
          browserLocalAssertion: host.hosted ? undefined : import.meta.env.VITE_ISAGI_RUNTIME_LOCAL,
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
