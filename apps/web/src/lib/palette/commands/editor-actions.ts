import { Code } from 'lucide-react';

import { worktreeActionsCopy } from '../../../copy/index.js';
import { openEditorFromPalette } from '../../editor/queries.js';
import type { PaletteCommand } from '../types.js';
import { worktreeIdFromValues } from './worktree-target.js';

/**
 * Open the worktree's editor, placing and focusing the durable editor context.
 *
 * It starts no process. Opening settles the placement and activates the pane;
 * the pane's own mount is what asks the runtime for a workbench, so the editor
 * is demand-driven rather than started by a palette row.
 *
 * Availability is the runtime's answer, not a re-derivation: `editorAvailable`
 * is true only when the host declared the capability and provisioning finished,
 * and a runtime that says otherwise refuses the operation anyway.
 */
export const openEditorCommand: PaletteCommand = {
  id: 'open-editor',
  label: worktreeActionsCopy.openEditor,
  icon: Code,
  group: 'worktree-actions',
  available: (ctx) =>
    Boolean(ctx.activeWorktree) && ctx.activeProject?.status === 'present' && ctx.editorAvailable,
  run: async (values, ctx) => {
    const worktreeId = worktreeIdFromValues(values, ctx);
    if (worktreeId === null) {
      return;
    }
    await openEditorFromPalette(worktreeId);
  },
};

export const editorActionCommands: readonly PaletteCommand[] = [openEditorCommand];
