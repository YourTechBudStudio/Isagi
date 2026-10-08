import { Trash2 } from 'lucide-react';

import type { ContextMenuItem } from '../../components/ContextMenu.js';
import { projectActionsCopy } from '../../copy/index.js';
import { handleDispatchedCommandError } from '../../lib/palette/dispatcher.js';
import type { ArgValues } from '../../lib/palette/types.js';

/**
 * A project's right-click menu in the rail, for present and disconnected rows
 * alike. It is only a trigger: the `delete-project` command owns the confirm and
 * the delete, targeted at this row's project rather than the active one.
 */
export function projectMenuItems(
  projectId: number,
  dispatchCommand: (entryId: string, values: ArgValues) => Promise<void>,
): ContextMenuItem[] {
  return [
    {
      label: projectActionsCopy.menu.delete,
      icon: Trash2,
      danger: true,
      onSelect: () =>
        void dispatchCommand('delete-project', { projectId: String(projectId) }).catch(
          handleDispatchedCommandError,
        ),
    },
  ];
}
