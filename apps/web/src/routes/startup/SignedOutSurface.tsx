import { useAtomValue } from '@effect/atom-react';

import { workbenchShownAtom } from '../../lib/auth/state.js';
import { useRegistry } from '../../lib/state/registry.js';
import { SignInForm } from './SignInForm.js';
import { BootSurface } from './StartupSurfaces.js';

/**
 * What the startup gate shows once the runtime has refused this page. If the workbench was
 * showing, the expiry screen comes first, and its Sign in opens the sign-in view without a reload.
 * A page that never showed the workbench goes straight to the sign-in view.
 */
export function SignedOutSurface() {
  const registry = useRegistry();
  const workbenchShown = useAtomValue(workbenchShownAtom);
  return workbenchShown ? (
    <BootSurface
      view={{ kind: 'session_expired', onSignIn: () => registry.set(workbenchShownAtom, false) }}
    />
  ) : (
    <SignInForm />
  );
}
