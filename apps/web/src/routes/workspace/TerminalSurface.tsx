import { SquareTerminal } from 'lucide-react';

import type { ShellPane, Surface } from '../../lib/workspace/types.js';
import { SplitPtySurface } from './SplitPtySurface.js';

/**
 * A terminal surface — the sibling of the agent surface. Its shells lay out as
 * floating glass panes on the halo, focused pane bright and the rest dimmed,
 * exactly like agents. (Drag-to-rearrange + resizable gutters are the shared
 * split-PTY slice deferred for both surface kinds; this is the simple split.)
 */
export function TerminalSurface({ surface }: { surface: Surface }) {
  const shells = surface.shells ?? [];
  return (
    <SplitPtySurface
      panes={shells}
      renderHeader={(shell) => <ShellPaneHeader shell={shell} />}
      renderBody={(shell) => shell.lines.join('\n')}
    />
  );
}

function ShellPaneHeader({ shell }: { shell: ShellPane }) {
  return (
    <>
      <SquareTerminal size={12} className="text-fg-subtle" />
      <span className="font-mono text-[10.5px] text-fg-muted">{shell.title}</span>
    </>
  );
}
