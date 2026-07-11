import type { AgentHarness, ControlPlaneSnapshot, HarnessLaunchProjection } from '@isagi/contracts';

// The runtime owns launchability (see `harnessLaunchDecision` on the runtime and
// ADR 0008): the snapshot carries a per-harness `launch` projection, and the web
// only reads it. Nothing here re-derives the onboarding/config/policy/inventory
// ladder — that would drift from what the runtime actually enforces.

type ReadyInventory = Extract<ControlPlaneSnapshot['inventory'], { readonly status: 'ready' }>;
export type ExecutableAvailability = ReadyInventory['node'];

export function harnessLaunch(
  snapshot: ControlPlaneSnapshot,
  harness: AgentHarness,
): HarnessLaunchProjection {
  const entry = snapshot.harnesses.find((candidate) => candidate.harness === harness);
  // The runtime always projects every supported harness; an absent entry could
  // only be an unknown harness, which is never launchable.
  const fallback: HarnessLaunchProjection = { status: 'blocked', reason: 'harness_missing' };
  return entry?.launch ?? fallback;
}

export function launchableHarnesses(snapshot: ControlPlaneSnapshot): readonly AgentHarness[] {
  return snapshot.harnesses
    .filter((entry) => entry.launch.status === 'launchable')
    .map((entry) => entry.harness);
}

// The single snapshot-derived routing decision for the startup gate. The gate
// component layers the query lifecycle (connecting / unreachable) on top of this;
// everything below is a pure function of the snapshot so it can be tested directly.
export type StartupGate =
  | { readonly kind: 'inventory_pending' }
  | { readonly kind: 'config_invalid'; readonly diagnostic: string | null }
  | {
      readonly kind: 'toolchain_blocked';
      readonly node: ExecutableAvailability;
      readonly packageManagers: ReadyInventory['packageManagers'];
      readonly environment: ReadyInventory['environment'];
    }
  | { readonly kind: 'onboarding' }
  | { readonly kind: 'ready' };

export function deriveStartupGate(snapshot: ControlPlaneSnapshot): StartupGate {
  if (snapshot.inventory.status === 'pending') return { kind: 'inventory_pending' };
  // Invalid config precedes the toolchain check: it needs a distinct manual repair
  // and restart, so pairing it with a toolchain nag would add noise without
  // helping recovery.
  if (snapshot.configStatus === 'invalid')
    return { kind: 'config_invalid', diagnostic: snapshot.configDiagnostic };
  const inventory = snapshot.inventory;
  const packageManagers = inventory.packageManagers;
  const hasPackageManager =
    packageManagers.pnpm === 'available' ||
    packageManagers.npm === 'available' ||
    packageManagers.bun === 'available';
  // Node and at least one package manager are the hard startup requirements. A
  // failed environment capture only degrades Docs later; it is not a hard block.
  if (inventory.node !== 'available' || !hasPackageManager)
    return {
      kind: 'toolchain_blocked',
      node: inventory.node,
      packageManagers,
      environment: inventory.environment,
    };
  if (!snapshot.onboardingComplete) return { kind: 'onboarding' };
  return { kind: 'ready' };
}
