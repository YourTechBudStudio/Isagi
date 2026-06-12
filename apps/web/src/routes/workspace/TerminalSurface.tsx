import { SquareTerminal } from 'lucide-react';

import { surfaceDetailCopy } from '../../copy/index.js';
import { formatRuntimeError, useSurfaceDetailQuery } from '../../lib/workspace/queries.js';
import type { Surface } from '../../lib/workspace/types.js';
import { PtySurface } from './PtySurface.js';
import { SurfaceFrameState } from './SurfaceFrameState.js';

export function TerminalSurface({ surface }: { surface: Surface }) {
  const detail = useSurfaceDetailQuery(surface.id);

  if (detail.isPending) {
    return (
      <SurfaceFrameState
        icon={SquareTerminal}
        title={surface.title}
        body={surfaceDetailCopy.terminal.loading}
      />
    );
  }

  if (detail.error) {
    return (
      <SurfaceFrameState
        icon={SquareTerminal}
        title={surface.title}
        body={surfaceDetailCopy.terminal.loadFailed(formatRuntimeError(detail.error))}
        tone="error"
      />
    );
  }

  return <PtySurface detail={detail.data} />;
}
