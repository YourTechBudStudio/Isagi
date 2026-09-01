import type {
  AgentHarness,
  ControlPlaneSnapshot,
  EditorProvisioningState,
  HarnessLaunchProjection,
} from '@isagi/contracts';

// The runtime owns launchability (see `harnessLaunchDecision` on the runtime and
// ADR 0008): the snapshot carries a per-harness `launch` projection, and the web
// only reads it. Nothing here re-derives the onboarding/config/policy/inventory
// ladder — that would drift from what the runtime actually enforces.

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
  | { readonly kind: 'onboarding' }
  | { readonly kind: 'editor_provisioning'; readonly state: EditorProvisioningState }
  | { readonly kind: 'ready' };

/**
 * Provisioning is the **last** beat, after onboarding. Ordering the long
 * download earlier would forfeit the first-run user's chance to complete harness
 * setup while it runs.
 *
 * A host that declares the editor capability has made a promise, so a failure
 * blocks readiness rather than degrading quietly; `not_applicable` is the
 * already-modelled way to proceed without an editor, and it falls through here
 * exactly like `ready` does, so an external runtime is unaffected.
 */
export function deriveStartupGate(snapshot: ControlPlaneSnapshot): StartupGate {
  if (snapshot.inventory.status === 'pending') return { kind: 'inventory_pending' };
  if (snapshot.configStatus === 'invalid')
    return { kind: 'config_invalid', diagnostic: snapshot.configDiagnostic };
  if (!snapshot.onboardingComplete) return { kind: 'onboarding' };
  const provisioning = snapshot.editorProvisioning;
  if (isTransientProvisioning(provisioning) || provisioning.status === 'failed')
    return { kind: 'editor_provisioning', state: provisioning };
  return { kind: 'ready' };
}

/** The four states the gate polls on; every other state is settled. */
export function isTransientProvisioning(state: EditorProvisioningState): boolean {
  return (
    state.status === 'checking' ||
    state.status === 'downloading' ||
    state.status === 'verifying' ||
    state.status === 'extracting'
  );
}

/**
 * "Supported local worktree" resolves to exactly this (D13): the runtime says the
 * editor is available. No locality is re-derived here — provisioning is enabled
 * only for a runtime the host declares managed, and managed-plus-hosted is
 * `local` by construction, so availability already implies co-location.
 */
export function editorAvailable(snapshot: ControlPlaneSnapshot): boolean {
  return snapshot.editorProvisioning.status === 'ready';
}
