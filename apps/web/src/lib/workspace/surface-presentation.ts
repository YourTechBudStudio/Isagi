import { Bot, CircleDashed, SquareTerminal } from 'lucide-react';

import type { IconType } from '../icon.js';
import type { PaneSessionKind } from './types.js';

/** Shared presentation metadata for surface identity across rail, palette, and canvas. */
export const SURFACE_PRESENTATION = {
  agent_session: { icon: Bot },
  terminal_session: { icon: SquareTerminal },
} satisfies Record<PaneSessionKind, { icon: IconType }>;

export const SESSIONLESS_SURFACE_ICON = CircleDashed;

export function paneSessionIcon(kind: PaneSessionKind | null | undefined): IconType {
  return kind ? SURFACE_PRESENTATION[kind].icon : SESSIONLESS_SURFACE_ICON;
}

export function surfaceSummaryIcon(paneKinds: readonly PaneSessionKind[]): IconType {
  return paneSessionIcon(paneKinds[0]);
}
