import type { WorkspaceData } from '../model.js';

export function project(input: {
  readonly id: number;
  readonly name: string;
  readonly surfaces?: WorkspaceData['projects'][number]['worktrees'][number]['surfaces'];
}): WorkspaceData['projects'][number] {
  return {
    id: input.id,
    name: input.name,
    rootPath: `/repo/${input.name}`,
    status: 'present',
    glyph: input.name.slice(0, 2).toUpperCase(),
    accent: 'blue',
    worktrees: [
      {
        id: input.id * 10,
        projectId: input.id,
        title: 'main',
        path: `/repo/${input.name}`,
        branch: 'main',
        head: 'abcdef0',
        isRoot: true,
        attention: 'idle',
        parked: false,
        surfaces: input.surfaces ?? [],
        activeSurfaceId: null,
      },
    ],
  };
}
