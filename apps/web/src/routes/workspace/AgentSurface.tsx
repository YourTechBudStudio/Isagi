import { Bot } from 'lucide-react';

import { formatRuntimeError, useSurfaceDetailQuery } from '../../lib/workspace/queries.js';
import type { Surface } from '../../lib/workspace/types.js';
import { PtySurface } from './PtySurface.js';
import { SurfaceFrameState } from './SurfaceFrameState.js';

export function AgentSurface({ surface }: { surface: Surface }) {
  const detail = useSurfaceDetailQuery(surface.id);

  if (detail.isPending) {
    return <SurfaceFrameState icon={Bot} title={surface.title} body="Loading agent surface..." />;
  }

  if (detail.error) {
    return (
      <SurfaceFrameState
        icon={Bot}
        title={surface.title}
        body={`Could not load this agent surface. ${formatRuntimeError(detail.error)}`}
        tone="error"
      />
    );
  }

  return <PtySurface detail={detail.data} />;
}
