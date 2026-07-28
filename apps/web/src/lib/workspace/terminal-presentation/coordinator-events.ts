import type { DurableSessionIdentity, RuntimeEvent } from '@isagi/contracts';

export type TerminalWorkspaceFact =
  | { readonly type: 'runtime_connected' }
  | { readonly type: 'runtime_event'; readonly event: RuntimeEvent }
  | { readonly type: 'durable_worktree_deleted'; readonly worktreeId: number }
  | { readonly type: 'durable_inventory_refresh_requested' }
  | {
      readonly type: 'placement_removed';
      readonly worktreeId: number;
      readonly surfaceId: number;
      readonly paneId?: number | undefined;
    }
  | { readonly type: 'durable_identity_deleted'; readonly identity: DurableSessionIdentity };

const listeners = new Set<(fact: TerminalWorkspaceFact) => void>();

export function publishTerminalWorkspaceFact(fact: TerminalWorkspaceFact) {
  for (const listener of listeners) listener(fact);
}

export function subscribeTerminalWorkspaceFacts(listener: (fact: TerminalWorkspaceFact) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
