import { FolderSymlink } from 'lucide-react';

import { paletteCopy } from '../../../copy/index.js';
import { relocateProjectPath } from '../../workspace/queries.js';
import type { Project } from '../../workspace/types.js';
import type { PaletteCommand } from '../types.js';

export const relocateProjectCommand: PaletteCommand = {
  id: 'relocate-project',
  label: 'Set project path',
  icon: FolderSymlink,
  group: 'global',
  available: (ctx) => relocatableProjects(ctx.projects).length > 0,
  args: [
    {
      kind: 'select',
      key: 'projectId',
      label: 'Missing project',
      options: (ctx) =>
        relocatableProjects(ctx.projects).map((project) => ({
          value: String(project.id),
          label: project.name,
          hint: project.rootPath,
        })),
    },
    {
      kind: 'path',
      key: 'path',
      label: 'New project root path',
      placeholder: paletteCopy.placeholders.repositoryRootPath,
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

/**
 * Missing *Git* projects. A folder project cannot be relocated at all — the
 * runtime refuses the request before it even checks whether the project is
 * missing — so offering one here would promise something the runtime declines.
 * Recovering a missing folder happens at the same path instead.
 */
function relocatableProjects(projects: readonly Project[]) {
  return projects.filter((project) => project.status === 'missing' && project.kind === 'git');
}
