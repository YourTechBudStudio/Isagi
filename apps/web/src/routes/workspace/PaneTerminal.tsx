import { useCallback, useEffect, useRef, useState } from 'react';

import { restoreActivePaneFocus, usePaneFocusTarget } from '../../lib/workspace/activation.js';
import type { PtyPaneSession } from '../../lib/workspace/pane-session/view.js';
import type { PtyStreamTransport } from '../../lib/workspace/pty-stream/index.js';
import { XtermSurface, type XtermSurfaceKeyHandler } from './XtermSurface.js';

/**
 * Pane-owned wrapper around the shared xterm renderer. Pane concerns stay here:
 * focus targeting, interactive stdin, runtime resize authority, and harness
 * keyboard shims.
 */
export function PaneTerminal({
  session,
  surfaceId,
  paneId,
  focused,
  locked,
  transport,
  onRendererWarning,
}: {
  readonly session: PtyPaneSession;
  readonly surfaceId: number;
  readonly paneId: number;
  readonly focused: boolean;
  readonly locked: boolean;
  readonly transport: PtyStreamTransport;
  readonly onRendererWarning: (message: string | null) => void;
}) {
  const focusedRef = useRef(focused);
  const focusHandleRef = useRef<(() => void) | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const shimShiftEnter = session.kind === 'agent_session';
  const disableScrollback = session.kind === 'agent_session' && session.harness === 'opencode';
  const initiallyInteractive = session.status === 'running';

  useEffect(() => {
    focusedRef.current = focused;
  }, [focused]);

  const focusTerminal = useCallback(() => {
    focusHandleRef.current?.();
  }, []);
  usePaneFocusTarget({
    surfaceId,
    paneId,
    priority: 100,
    enabled: terminalReady,
    focus: focusTerminal,
  });

  const handleCustomKey = useCallback<XtermSurfaceKeyHandler>(
    (event, { sendInput }) => {
      if (!shimShiftEnter || event.type !== 'keydown' || event.key !== 'Enter' || !event.shiftKey) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      sendInput('\x1b[200~\n\x1b[201~');
      return true;
    },
    [shimShiftEnter],
  );

  const handleInput = useCallback(
    (data: string) => {
      transport.sendInput(data);
    },
    [transport],
  );

  const handleFit = useCallback(
    (cols: number, rows: number) => {
      transport.sendResize(cols, rows);
    },
    [transport],
  );

  const handleReadyChange = useCallback((ready: boolean) => {
    setTerminalReady(ready);
  }, []);

  const handleFocusHandleChange = useCallback((focus: (() => void) | null) => {
    focusHandleRef.current = focus;
  }, []);

  const handleInteractiveChange = useCallback((interactive: boolean) => {
    if (interactive && focusedRef.current) {
      restoreActivePaneFocus();
    }
  }, []);

  useEffect(() => {
    if (!focused || !terminalReady) {
      return;
    }
    restoreActivePaneFocus();
  }, [focused, terminalReady]);

  return (
    <XtermSurface
      transport={transport}
      initiallyInteractive={initiallyInteractive}
      locked={locked}
      disableScrollback={disableScrollback}
      onInput={handleInput}
      onFit={handleFit}
      onReadyChange={handleReadyChange}
      onFocusHandleChange={handleFocusHandleChange}
      onInteractiveChange={handleInteractiveChange}
      onRendererWarning={onRendererWarning}
      onCustomKey={handleCustomKey}
    />
  );
}
