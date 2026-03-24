import {
  ChevronRight,
  Code2,
  GitBranch,
  PanelRight,
  Square,
  Terminal,
} from "lucide-react";
import { useRef, useState } from "react";

import { GitStatusPopover } from "@/components/session/GitStatusPopover";
import { sessionPanelTransition } from "@/components/session/sessionLayout.constants";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FloatingActionBar } from "@/components/ui/FloatingActionBar";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";
import { useHideOnScrollHeader } from "@/lib/hooks/useHideOnScrollHeader";
import type {
  SessionExecutionState,
  SessionKind,
} from "@/lib/mock/session.mock";

type SessionActionBarProps = {
  readonly kind: SessionKind;
  readonly breadcrumbs: ReadonlyArray<string>;
  readonly currentContext: string;
  readonly execution: SessionExecutionState;
  readonly rightInset: number;
  readonly isArtifactsOpen: boolean;
  readonly onToggleArtifacts: () => void;
};

export function SessionActionBar({
  kind,
  breadcrumbs,
  currentContext,
  execution,
  rightInset,
  isArtifactsOpen,
  onToggleArtifacts,
}: SessionActionBarProps) {
  const hidden = useHideOnScrollHeader();
  const [gitOpen, setGitOpen] = useState(false);
  const gitRef = useRef<HTMLButtonElement>(null);

  return (
    <FloatingActionBar
      hidden={hidden}
      rightInset={rightInset}
      rightTransition={sessionPanelTransition}
      className="left-[calc(var(--layout-sidebar-width)+1.5rem)]"
    >
      <div className="text-text-tertiary pointer-events-auto flex items-center gap-2 text-sm font-medium">
        {breadcrumbs.map((crumb, index) => (
          <div key={`${crumb}-${index}`} className="flex items-center gap-2">
            <span className="hover:text-text-secondary cursor-pointer transition-colors">
              {crumb}
            </span>
            {index < breadcrumbs.length - 1 ? (
              <ChevronRight className="h-3.5 w-3.5 opacity-50" />
            ) : null}
          </div>
        ))}
        <ChevronRight className="h-3.5 w-3.5 opacity-50" />
        <span className="text-text-primary">{currentContext}</span>

        {kind !== "task" && (
          <div className="ml-2">
            <Badge
              tone={kind === "shaping" ? "blue" : "neutral"}
              className="capitalize"
            >
              {kind}
            </Badge>
          </div>
        )}
      </div>

      <div className="bg-canvas-elevated/80 pointer-events-auto flex items-center gap-3 rounded-2xl border border-white/10 p-1.5 shadow-lg backdrop-blur-md">
        <div className="flex items-center gap-1 border-r border-white/10 pr-2">
          <button
            ref={gitRef}
            type="button"
            onClick={() => setGitOpen(open => !open)}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-white/5"
          >
            <GitBranch className="text-text-secondary h-4 w-4" />
            <span className="text-text-secondary font-mono text-sm">
              {execution.branchName}
            </span>
            <div
              className={cn(
                "ml-0.5 h-1.5 w-1.5 rounded-full",
                execution.hasUncommittedChanges
                  ? "bg-accent-amber animate-pulse"
                  : "bg-accent-green",
              )}
              title={
                execution.hasUncommittedChanges
                  ? "Uncommitted changes"
                  : "Working tree clean"
              }
            />
          </button>

          <GitStatusPopover
            open={gitOpen}
            onClose={() => setGitOpen(false)}
            anchorRef={gitRef}
            execution={execution}
          />
        </div>

        <div className="flex items-center gap-1 px-1">
          <IconButton
            icon={<Terminal className="h-4 w-4" />}
            title="Open Terminal"
          />
          <IconButton
            icon={<Code2 className="h-4 w-4" />}
            title="Open VS Code"
          />
        </div>

        <Button
          variant="primary"
          size="md"
          leadingIcon={<Square className="h-4 w-4" />}
          className="bg-accent-violet hover:bg-accent-violet/90 text-canvas ml-1"
        >
          Close Session
        </Button>

        {kind !== "scratch" && (
          <div className="ml-1 border-l border-white/10 pl-1">
            <IconButton
              icon={<PanelRight className="h-4 w-4" />}
              onClick={onToggleArtifacts}
              title="Toggle Artifacts"
              className={cn(isArtifactsOpen && "text-text-primary bg-white/5")}
            />
          </div>
        )}
      </div>
    </FloatingActionBar>
  );
}
