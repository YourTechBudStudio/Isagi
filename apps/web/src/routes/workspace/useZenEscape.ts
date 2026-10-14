import { useAtomValue } from '@effect/atom-react';
import { useEffect } from 'react';

import { isUnclaimedEscape } from '../../lib/escape.js';
import { paletteAtom, paletteSelectors } from '../../lib/palette/store.js';
import { useRegistry } from '../../lib/state/registry.js';
import { setZen, zenAtom } from '../../lib/workspace/store.js';

/**
 * Esc exits zen, unless the palette owns Esc or something inside the page already handled it (an
 * embedded Fluidcast player interrupting its speech, say). Listens on `window` in the bubble phase,
 * so handlers inside the page run first.
 */
export function useZenEscape(): void {
  const registry = useRegistry();
  const zen = useAtomValue(zenAtom);
  const paletteOpen = useAtomValue(paletteAtom, paletteSelectors.open);

  useEffect(() => {
    if (!zen) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isUnclaimedEscape(event) || paletteOpen) return;
      event.preventDefault();
      setZen(registry, false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zen, paletteOpen, registry]);
}
