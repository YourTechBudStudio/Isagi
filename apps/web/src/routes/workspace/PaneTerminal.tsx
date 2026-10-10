import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { useRegistry } from '../../lib/state/registry.js';
import { restoreActivePaneFocus, usePaneFocusTarget } from '../../lib/workspace/activation.js';
import type { TerminalPresentationController } from '../../lib/workspace/terminal-presentation/controller.js';
import { TerminalRevealSlot } from './terminal-reveal/index.js';

/** React-owned destination slot for a cache-owned stable terminal host. */
export function PaneTerminal({
  surfaceId,
  paneId,
  focused,
  presentation,
}: {
  readonly surfaceId: number;
  readonly paneId: number;
  readonly focused: boolean;
  readonly presentation: TerminalPresentationController;
}) {
  const destinationRef = useRef<HTMLDivElement | null>(null);
  const registry = useRegistry();
  const focusTerminal = useCallback(() => presentation.focus(), [presentation]);
  const snapshot = useSyncExternalStore(
    presentation.subscribe,
    presentation.getSnapshot,
    presentation.getSnapshot,
  );

  usePaneFocusTarget({
    surfaceId,
    paneId,
    priority: 100,
    enabled: true,
    focus: focusTerminal,
  });

  useEffect(() => {
    const destination = destinationRef.current;
    if (!destination) return;
    return presentation.registerSlot(destination);
  }, [presentation]);

  useEffect(() => {
    presentation.setFocused(focused);
    if (focused) restoreActivePaneFocus(registry);
  }, [focused, presentation, registry]);

  // While covered the host is `inert`, so every focus attempt made before the reveal (the effect
  // above, the activation frame's self-assert, the focus router's deferred call) lands nowhere and
  // keys go to whatever held focus before. Re-assert once the reveal has un-inerted the host;
  // `setFocused` keeps the overlay-ownership gate, so an open palette or drawer keeps focus.
  const revealed = snapshot.readiness.phase === 'revealed';
  useEffect(() => {
    if (revealed && focused) presentation.setFocused(true);
  }, [revealed, focused, presentation]);

  return <TerminalRevealSlot revealed={revealed} hostRef={destinationRef} />;
}
