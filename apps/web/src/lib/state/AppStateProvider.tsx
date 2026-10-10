import { RegistryContext } from '@effect/atom-react';
import type { AtomRegistry } from 'effect/reactivity';
import type { ReactNode } from 'react';

import { AppRegistryContext } from './registry.js';

/**
 * Provides one app registry to our hooks (`useRegistry`, `useAppRun`) and to atom-react's hooks
 * (`useAtomValue`, ...), so both always read the same state.
 */
export function AppStateProvider({
  registry,
  children,
}: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly children?: ReactNode;
}) {
  return (
    <AppRegistryContext.Provider value={registry}>
      <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
    </AppRegistryContext.Provider>
  );
}
