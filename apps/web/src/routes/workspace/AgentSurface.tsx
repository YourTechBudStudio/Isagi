import { AttentionDot } from '../../components/AttentionDot.js';
import type { AgentSession, Surface } from '../../lib/workspace/types.js';
import { SplitPtySurface } from './SplitPtySurface.js';

/**
 * An agent surface: its agent sessions laid out as floating glass panes on
 * the halo. The focused pane is bright; the rest dim to ~0.5 so one agent owns
 * your attention even while the others stream. (Drag-to-rearrange + resizable
 * gutters are a separate follow-up slice; this is the simple auto-split.)
 */
export function AgentSurface({ surface }: { surface: Surface }) {
  const agentSessions = surface.agentSessions ?? [];
  return (
    <SplitPtySurface
      panes={agentSessions}
      renderHeader={(agentSession) => <AgentPaneHeader agentSession={agentSession} />}
      renderBody={(agentSession) => agentSession.transcript.join('\n')}
    />
  );
}

function AgentPaneHeader({ agentSession }: { agentSession: AgentSession }) {
  return (
    <>
      <AttentionDot state={agentSession.attention} />
      <span className="font-mono text-[10.5px] text-fg-muted">{agentSession.harness}</span>
    </>
  );
}
