import { motion } from 'motion/react';
import { useState } from 'react';

import { deriveStartupGate } from '../../lib/control-plane/launchability.js';
import {
  useControlPlaneQuery,
  useRefreshInventoryMutation,
} from '../../lib/control-plane/queries.js';
import { DURATION, EASE_EXPO } from '../../lib/motion.js';
import { formatRuntimeError } from '../../lib/workspace/runtime-data.js';
import { WorkspacePage } from '../workspace/WorkspacePage.js';
import { OnboardingFlow } from './OnboardingFlow.js';
import { BootSurface, type BootView } from './StartupSurfaces.js';

/**
 * The single route into the workspace. It renders `WorkspacePage` — and therefore
 * mounts every workspace hook, subscription, and the command palette — only once
 * the runtime's control plane reports a supported toolchain and completed
 * onboarding.
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
 */
export function StartupGate() {
  const query = useControlPlaneQuery();
  const refreshInventory = useRefreshInventoryMutation();
  const [onboardingHeld, setOnboardingHeld] = useState(false);
  const [splashDone, setSplashDone] = useState(false);

  const snapshot = query.data;
  const gate = snapshot ? deriveStartupGate(snapshot) : null;

  if (snapshot && (gate?.kind === 'onboarding' || onboardingHeld)) {
    return (
      <OnboardingFlow
        snapshot={snapshot}
        onCommitted={() => setOnboardingHeld(true)}
        onComplete={() => setOnboardingHeld(false)}
      />
    );
  }

  const view: BootView | null = !snapshot
    ? query.isPending
      ? { kind: 'connecting' }
      : {
          kind: 'runtime_unreachable',
          error: formatRuntimeError(query.error),
          retrying: query.isFetching,
          onRetry: () => void query.refetch(),
        }
    : gate?.kind === 'inventory_pending'
      ? { kind: 'environment_pending' }
      : gate?.kind === 'config_invalid'
        ? { kind: 'config_invalid', diagnostic: gate.diagnostic }
        : gate?.kind === 'toolchain_blocked'
          ? {
              kind: 'toolchain_blocked',
              gate,
              checking: refreshInventory.isPending,
              onCheckAgain: () => refreshInventory.mutate(),
            }
          : null; // 'ready' — onboarding is handled above.

  if (view) {
    return <BootSurface view={view} />;
  }

  return (
    <>
      <WorkspacePage />
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
