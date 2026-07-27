import { Ban, Trash2 } from 'lucide-react';

import type { AgentHarness, HarnessLaunchBlockReason } from '@isagi/contracts';

import { Button } from '../../components/Button.js';
import { agentSessionCopy } from '../../copy/index.js';
import { harnessLabel } from '../../lib/harness-labels.js';

// A durable agent pane whose harness policy forbids a new process. This prompt
// owns its sole close action; the parent omits its context menu and action cluster.
// With no cluster to fall back on, this button is the pane's action surface, so it
// carries the running sweep itself while the delete is in flight.
export function BlockedPanePrompt({
  harness,
  reason,
  onClose,
  deletePending = false,
}: {
  readonly harness: AgentHarness | null;
  readonly reason: HarnessLaunchBlockReason;
  readonly onClose: () => void;
  readonly deletePending?: boolean;
}) {
  const status = agentSessionCopy.launchBlock.status[reason];

  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-5">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Ban size={18} aria-hidden className="text-error" />
        <div className="space-y-1">
          <p className="font-mono text-[12px] text-fg-muted">
            {harness
              ? agentSessionCopy.launchBlock.harnessStatus(harnessLabel(harness), status)
              : status}
          </p>
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">
            {agentSessionCopy.launchBlock.body[reason]}
          </p>
          {reason === 'harness_disabled' ? (
            <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">
              {agentSessionCopy.launchBlock.disabledHint}
            </p>
          ) : null}
        </div>
        <span className="relative inline-flex overflow-hidden rounded-md">
          <Button
            variant="secondary"
            size="sm"
            icon={Trash2}
            disabled={deletePending}
            onClick={onClose}
          >
            {agentSessionCopy.launchBlock.close}
          </Button>
          {deletePending && (
            <span aria-hidden className="command-sweep command-sweep-danger command-sweep-pinned" />
          )}
        </span>
      </div>
    </div>
  );
}
