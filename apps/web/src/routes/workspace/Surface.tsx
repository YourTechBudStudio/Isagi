import { useAtomValue } from '@effect/atom-react';
import { AnimatePresence } from 'motion/react';

import type { AgentSessionMetadata } from '@isagi/contracts';

import { surfaceDetailCopy } from '../../copy/index.js';
import { queryError } from '../../lib/state/result.js';
import { formatRuntimeError, surfaceDetailAtom } from '../../lib/workspace/queries.js';
import { surfaceSummaryIcon } from '../../lib/workspace/surface-presentation.js';
import type { Surface as WorkspaceSurface } from '../../lib/workspace/types.js';
import { workflowPresentationStatus } from '../../lib/workspace/workflow/derive.js';
import { useAttachedWorkflowRun } from '../../lib/workspace/workflow/queries.js';
import { EditorPaneContainer } from './EditorPaneContainer.js';
import { FluidcastFailurePane, type FluidcastFailedAgentSession } from './FluidcastFailurePane.js';
import { FluidcastPane, type FluidcastAgentSession } from './FluidcastPane.js';
import { PtyPane } from './PtyPane.js';
import { SurfaceFrameState } from './SurfaceFrameState.js';
import { SurfaceLayout } from './SurfaceLayout.js';
import { WorkflowSurfaceGlow } from './WorkflowSurfaceGlow.js';

export function Surface({ surface }: { surface: WorkspaceSurface }) {
  const detail = useAtomValue(surfaceDetailAtom(surface.id));
  const workflowSummary = useAttachedWorkflowRun(surface.id);
  const workflowStatus = workflowSummary ? workflowPresentationStatus(workflowSummary) : null;
  const Icon = surfaceSummaryIcon(surface.paneKinds);

  if (detail._tag === 'Initial') {
    return <SurfaceFrameState icon={Icon} title={surface.title} body={surfaceDetailCopy.loading} />;
  }

  // A failure wins over data kept from an earlier read, as the old `detail.error` check did.
  if (detail._tag === 'Failure') {
    return (
      <SurfaceFrameState
        icon={Icon}
        title={surface.title}
        body={surfaceDetailCopy.loadFailed(formatRuntimeError(queryError(detail)))}
        tone="error"
      />
    );
  }

  return (
    <div className="relative h-full min-h-0 min-w-0">
      <SurfaceLayout
        detail={detail.value}
        // The kind dispatch happens here, before `PtyPane`, so an editor pane
        // never reaches PTY attach or terminal-presentation code at all, and an
        // agent pane mounts a terminal only in terminal mode: neither Fluidcast
        // nor a failed switch to it can have a terminal auto-attach behind it.
        renderPane={({ pane, focused, onFocus }) => {
          if (pane.session?.kind === 'editor_context') {
            return (
              <EditorPaneContainer
                pane={pane}
                editorContext={pane.session.editorContext}
                surface={detail.value}
                focused={focused}
                onFocus={onFocus}
              />
            );
          }
          const agentSession =
            pane.session?.kind === 'agent_session' ? pane.session.agentSession : null;
          if (agentSession && isFluidcastMode(agentSession)) {
            return (
              <FluidcastPane
                pane={pane}
                surface={detail.value}
                agentSession={agentSession}
                focused={focused}
                onFocus={onFocus}
              />
            );
          }
          if (agentSession && isFluidcastFailed(agentSession)) {
            return (
              <FluidcastFailurePane
                pane={pane}
                surface={detail.value}
                agentSession={agentSession}
                focused={focused}
                onFocus={onFocus}
              />
            );
          }
          return <PtyPane pane={pane} surface={detail.value} focused={focused} onFocus={onFocus} />;
        }}
      />
      <AnimatePresence initial={false}>
        {workflowStatus ? (
          <WorkflowSurfaceGlow key="workflow-glow" status={workflowStatus} />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function isFluidcastMode(
  agentSession: AgentSessionMetadata,
): agentSession is FluidcastAgentSession {
  return agentSession.interaction.mode === 'fluidcast';
}

function isFluidcastFailed(
  agentSession: AgentSessionMetadata,
): agentSession is FluidcastFailedAgentSession {
  return agentSession.interaction.mode === 'fluidcast_failed';
}
