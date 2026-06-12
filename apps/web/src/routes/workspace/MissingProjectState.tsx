import { Unlink } from 'lucide-react';

import { EmptyState } from '../../components/EmptyState.js';
import { missingProjectCopy } from '../../copy/index.js';
import type { MissingProject } from '../../lib/workspace/types.js';
import { MissingProjectActions } from './MissingProjectActions.js';

/**
 * The canvas state for a project Isagi can't reach — the path, the reason, and
 * the recovery actions, given the room the rail row can't spare. The confirm
 * step for removal lives inline in {@link MissingProjectActions}, not in a
 * floating overlay.
 */
export function MissingProjectState({ project }: { project: MissingProject }) {
  return (
    <EmptyState
      halo="error"
      wide
      eyebrow={missingProjectCopy.eyebrow}
      icon={
        <div className="grid size-14 place-items-center rounded-2xl border border-error/30 bg-error/8 text-error shadow-soft">
          <Unlink size={26} strokeWidth={1.6} />
        </div>
      }
      title={missingProjectCopy.title}
      body={
        <>
          {missingProjectCopy.bodyPrefix}{' '}
          <span className="rounded-md bg-black/25 px-1.5 py-0.5 font-mono text-[13px] text-fg">
            {project.rootPath}
          </span>{' '}
          {missingProjectCopy.bodySuffix(project)}
        </>
      }
      actions={<MissingProjectActions project={project} />}
      aside={missingProjectCopy.aside}
    />
  );
}
