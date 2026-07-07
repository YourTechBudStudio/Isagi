import { AnimatePresence } from 'motion/react';

import { surfaceDetailCopy } from '../../copy/index.js';
import { formatRuntimeError, useSurfaceDetailQuery } from '../../lib/workspace/queries.js';
import { surfaceSummaryIcon } from '../../lib/workspace/surface-presentation.js';
import type { Surface as WorkspaceSurface } from '../../lib/workspace/types.js';
import { workflowPresentationStatus } from '../../lib/workspace/workflow-derive.js';
import { selectRootRunForSurface, useWorkflowRunStore } from '../../lib/workspace/workflow-runs.js';
import { PtyPane } from './PtyPane.js';
import { SurfaceFrameState } from './SurfaceFrameState.js';
import { SurfaceLayout } from './SurfaceLayout.js';
import { WorkflowSurfaceGlow } from './WorkflowSurfaceGlow.js';

export function Surface({ surface }: { surface: WorkspaceSurface }) {
  const detail = useSurfaceDetailQuery(surface.id);
  const workflowSummary = useWorkflowRunStore(selectRootRunForSurface(surface.id));
  const workflowStatus = workflowSummary ? workflowPresentationStatus(workflowSummary) : null;
  const Icon = surfaceSummaryIcon(surface.paneKinds);

  if (detail.isPending) {
    return <SurfaceFrameState icon={Icon} title={surface.title} body={surfaceDetailCopy.loading} />;
  }

  if (detail.error) {
    return (
      <SurfaceFrameState
        icon={Icon}
        title={surface.title}
        body={surfaceDetailCopy.loadFailed(formatRuntimeError(detail.error))}
        tone="error"
      />
    );
  }

  return (
    <div className="relative h-full min-h-0 min-w-0">
      <SurfaceLayout
        detail={detail.data}
        renderPane={({ pane, focused, onFocus }) => (
          <PtyPane pane={pane} surface={detail.data} focused={focused} onFocus={onFocus} />
        )}
      />
      <AnimatePresence initial={false}>
        {workflowStatus ? (
          <WorkflowSurfaceGlow key="workflow-glow" status={workflowStatus} />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
