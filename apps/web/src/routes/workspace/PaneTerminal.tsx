import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

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
    if (focused) restoreActivePaneFocus();
  }, [focused, presentation]);

  return (
    <TerminalRevealSlot
      revealed={snapshot.readiness.phase === 'revealed'}
      hostRef={destinationRef}
    />
  );
}
