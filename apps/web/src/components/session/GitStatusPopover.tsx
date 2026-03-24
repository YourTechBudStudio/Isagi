import type { RefObject } from "react";

import { Popover } from "@/components/ui/Popover";
import type { SessionExecutionState } from "@/lib/mock/session.mock";

type GitStatusPopoverProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: RefObject<HTMLButtonElement | null>;
  readonly execution: SessionExecutionState;
};

export function GitStatusPopover({
  open,
  onClose,
  anchorRef,
  execution,
}: GitStatusPopoverProps) {
  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} minWidth={220}>
      <div className="p-2">
        <div className="text-text-secondary mb-2 px-2 text-[10px] font-bold tracking-wider uppercase">
          Execution State
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm">
            <span className="text-text-secondary">Branch</span>
            <span className="text-text-primary font-mono text-xs">
              {execution.branchName}
            </span>
          </div>
          <div className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm">
            <span className="text-text-secondary">Mode</span>
            <span className="text-text-primary text-xs capitalize">
              {execution.mode.replaceAll("_", " ")}
            </span>
          </div>
          <div className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm">
            <span className="text-text-secondary">Changes</span>
            <span
              className={
                execution.hasUncommittedChanges
                  ? "text-accent-amber text-xs font-medium"
                  : "text-accent-green text-xs font-medium"
              }
            >
              {execution.hasUncommittedChanges ? "Uncommitted" : "Clean"}
            </span>
          </div>
        </div>

        <div className="my-1.5 border-t border-white/5" />

        <div className="text-text-secondary mb-2 px-2 pt-1 text-[10px] font-bold tracking-wider uppercase">
          Actions
        </div>

        <div className="flex flex-col gap-0.5">
          {execution.actions.map(action => (
            <button
              key={action.id}
              type="button"
              className="text-text-primary flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-white/5"
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}
