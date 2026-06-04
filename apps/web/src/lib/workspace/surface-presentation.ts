import { Bot, Code, FileText, Globe, SquareTerminal } from 'lucide-react';

import type { IconType } from '../icon.js';
import type { SurfaceKind } from './types.js';

/** Shared presentation metadata for surface identity across rail, palette, and canvas. */
export const SURFACE_PRESENTATION = {
  agent: { icon: Bot },
  terminal: { icon: SquareTerminal },
  browser: { icon: Globe },
  editor: { icon: Code },
  artifact: { icon: FileText },
} satisfies Record<SurfaceKind, { icon: IconType }>;

export function surfaceIcon(kind: SurfaceKind): IconType {
  return SURFACE_PRESENTATION[kind].icon;
}
