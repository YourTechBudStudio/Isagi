import { FolderSymlink } from 'lucide-react';

import { relocateProjectPath } from '../../workspace/queries.js';
import type { PaletteCommand } from '../types.js';

export const relocateProjectCommand: PaletteCommand = {
  id: 'relocate-project',
  label: 'Set project path',
  icon: FolderSymlink,
  group: 'global',
  available: (ctx) => ctx.projects.some((project) => project.status === 'missing'),
  args: [
    {
      kind: 'select',
      key: 'projectId',
      label: 'Missing project',
      options: (ctx) =>
        ctx.projects
          .filter((project) => project.status === 'missing')
          .map((project) => ({
            value: String(project.id),
            label: project.name,
            hint: project.rootPath,
          })),
    },
    {
      kind: 'path',
      key: 'path',
      label: 'New project root path',
      placeholder: 'Type the repository root path…',
    },
  ],
  run: (values) => {
    const projectId = Number(values.projectId);
    const path = values.path?.trim();
    if (Number.isInteger(projectId) && projectId > 0 && path) {
      return relocateProjectPath(projectId, path);
    }
    return undefined;
  },
};
