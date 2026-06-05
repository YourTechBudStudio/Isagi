import { FolderPlus } from 'lucide-react';

import { useWorkspaceStore } from '../../workspace/store.js';
import type { PaletteCommand } from '../types.js';

export const addProjectCommand: PaletteCommand = {
  id: 'add-project',
  label: 'Add project',
  icon: FolderPlus,
  group: 'global',
  args: [
    {
      kind: 'path',
      key: 'path',
      label: 'Project root path',
      placeholder: 'Type a repository root path…',
    },
  ],
  run: (values) => {
    const path = values.path?.trim();
    if (path) {
      return useWorkspaceStore.getState().addProjectPath(path);
    }
    return undefined;
  },
};
