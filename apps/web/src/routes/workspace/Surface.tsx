import { surfaceDetailCopy } from '../../copy/index.js';
import { formatRuntimeError, useSurfaceDetailQuery } from '../../lib/workspace/queries.js';
import { surfaceSummaryIcon } from '../../lib/workspace/surface-presentation.js';
import type { Surface as WorkspaceSurface } from '../../lib/workspace/types.js';
import { PtyPane } from './PtyPane.js';
import { SurfaceFrameState } from './SurfaceFrameState.js';
import { SurfaceLayout } from './SurfaceLayout.js';

export function Surface({ surface }: { surface: WorkspaceSurface }) {
  const detail = useSurfaceDetailQuery(surface.id);
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
    <SurfaceLayout
      detail={detail.data}
      renderPane={({ pane, focused, onFocus }) => (
        <PtyPane pane={pane} surface={detail.data} focused={focused} onFocus={onFocus} />
      )}
    />
  );
}
