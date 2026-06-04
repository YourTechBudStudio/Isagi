import type { AttentionState } from '../lib/workspace/types.js';
import { Tooltip } from './Tooltip.js';

/**
 * The single calm attention signal used across the shell (rail, tabs, agents,
 * commands). Working breathes, waiting glows softly, idle/error are still.
 * Never loud — the user must not be yanked out of flow.
 *
 * The 7px dot carries a dry tooltip naming its state, so the color mapping is
 * learnable and the signal does not depend on hue alone (accessibility). The
 * trigger has an enlarged invisible hit area; the visible dot is decorative.
 */

const STATE_STYLES: Record<AttentionState, string> = {
  working: 'bg-working animate-breathe',
  waiting: 'bg-waiting animate-glow',
  idle: 'bg-idle',
  error: 'bg-error',
};

const STATE_LABELS: Record<AttentionState, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  idle: 'Idle',
  error: 'Error',
};

export function AttentionDot({ state }: { state: AttentionState }) {
  return (
    <Tooltip label={STATE_LABELS[state]}>
      <span
        role="img"
        aria-label={STATE_LABELS[state]}
        className="-m-1 grid flex-none place-items-center p-1"
      >
        <span aria-hidden className={`block size-1.75 rounded-full ${STATE_STYLES[state]}`} />
      </span>
    </Tooltip>
  );
}
