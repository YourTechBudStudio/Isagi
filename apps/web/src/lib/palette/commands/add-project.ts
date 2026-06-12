import { FolderPlus } from 'lucide-react';

import { paletteCopy } from '../../../copy/index.js';
import { addProjectPath } from '../../workspace/queries.js';
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
      placeholder: paletteCopy.placeholders.projectRootPath,
    },
  ],
  run: (values) => {
    const path = values.path?.trim();
    if (path) {
      return addProjectPath(path);
    }
    return undefined;
  },
};
