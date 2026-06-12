import { Bot } from 'lucide-react';

import { surfaceDetailCopy } from '../../copy/index.js';
import { formatRuntimeError, useSurfaceDetailQuery } from '../../lib/workspace/queries.js';
import type { Surface } from '../../lib/workspace/types.js';
import { PtySurface } from './PtySurface.js';
import { SurfaceFrameState } from './SurfaceFrameState.js';

export function AgentSurface({ surface }: { surface: Surface }) {
  const detail = useSurfaceDetailQuery(surface.id);

  if (detail.isPending) {
    return (
      <SurfaceFrameState icon={Bot} title={surface.title} body={surfaceDetailCopy.agent.loading} />
    );
  }

  if (detail.error) {
    return (
      <SurfaceFrameState
        icon={Bot}
        title={surface.title}
        body={surfaceDetailCopy.agent.loadFailed(formatRuntimeError(detail.error))}
        tone="error"
      />
    );
  }

  return <PtySurface detail={detail.data} />;
}
