import { PanelBottom, PanelRight, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { useCallback, useMemo } from 'react';

import { ContextMenu } from '../../components/ContextMenu.js';
import type { PaneChromeActions } from './usePaneChromeActions.js';

/**
 * Wraps an element in the pane's context menu (split, delete), or returns it unchanged when the
 * pane offers no shared actions. Both the header and some pane bodies carry the menu.
 */
export type WithPaneMenu = (children: ReactElement) => ReactElement;

export function usePaneMenu(chrome: PaneChromeActions, enabled: boolean): WithPaneMenu {
  const { locked, onSplitRight, onSplitDown, onDelete, menuDeletePending } = chrome;
  const items = useMemo(
    () => [
      { label: 'Split Right', icon: PanelRight, disabled: locked, onSelect: onSplitRight },
      { label: 'Split Down', icon: PanelBottom, disabled: locked, onSelect: onSplitDown },
      {
        label: 'Delete pane',
        icon: Trash2,
        danger: true,
        keepsMenuOpen: true,
        pending: menuDeletePending,
        disabled: locked,
        onSelect: () => onDelete('menu'),
      },
    ],
    [locked, menuDeletePending, onDelete, onSplitDown, onSplitRight],
  );
  return useCallback(
    (children: ReactElement) =>
      enabled ? (
        <ContextMenu
          items={items}
          error={chrome.deleteError}
          onResultDismissed={chrome.onDeleteResultDismissed}
        >
          {children}
        </ContextMenu>
      ) : (
        children
      ),
    [chrome.deleteError, chrome.onDeleteResultDismissed, enabled, items],
  );
}
