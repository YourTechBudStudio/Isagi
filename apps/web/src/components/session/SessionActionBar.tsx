import { motion, useMotionValueEvent, useScroll } from "framer-motion";
import {
  CheckCircle2,
  ChevronRight,
  Code2,
  GitBranch,
  PanelRight,
  Terminal,
} from "lucide-react";
import { useRef, useState } from "react";

import { sessionPanelTransition } from "@/components/session/sessionLayout.constants";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import type { SessionKind } from "@/lib/mock/session.mock";

type SessionActionBarProps = {
  readonly kind: SessionKind;
  readonly breadcrumbs: ReadonlyArray<string>;
  readonly currentContext: string;
  readonly branchName: string;
  readonly rightInset: number;
  readonly isArtifactsOpen: boolean;
  readonly onToggleArtifacts: () => void;
};

export function SessionActionBar({
  kind,
  breadcrumbs,
  currentContext,
  branchName,
  rightInset,
  isArtifactsOpen,
  onToggleArtifacts,
}: SessionActionBarProps) {
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const gitRef = useRef<HTMLButtonElement>(null);

  useMotionValueEvent(scrollY, "change", latest => {
    const previous = scrollY.getPrevious() ?? 0;
    if (latest > previous && latest > 50) {
      setHidden(true);
      setGitOpen(false); // Close popover on scroll
    } else {
      setHidden(false);
    }
  });

  const headerClassName = cn(
    "pointer-events-none fixed top-6 z-30 flex items-center justify-between",
    "left-[calc(var(--layout-sidebar-width)+1.5rem)]",
  );

  return (
    <motion.header
      initial={false}
      animate={{
        y: hidden ? "-150%" : 0,
        right: rightInset,
      }}
      transition={{
        y: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
        right: sessionPanelTransition,
      }}
      className={headerClassName}
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
            onClick={() => setGitOpen(!gitOpen)}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-white/5"
          >
            <GitBranch className="text-text-secondary h-4 w-4" />
            <span className="text-text-secondary font-mono text-sm">
              {branchName}
            </span>
            <div
              className="bg-accent-amber ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full"
              title="Uncommitted changes"
            />
          </button>

          <Popover
            open={gitOpen}
            onClose={() => setGitOpen(false)}
            anchorRef={gitRef}
            minWidth={220}
          >
            <div className="p-2">
              <div className="text-text-secondary mb-2 px-2 text-[10px] font-bold tracking-wider uppercase">
                Execution State
              </div>
              <div className="flex flex-col gap-0.5">
                <div className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm">
                  <span className="text-text-secondary">Mode</span>
                  <span className="text-text-primary text-xs">Repo Root</span>
                </div>
                <div className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm">
                  <span className="text-text-secondary">Changes</span>
                  <span className="text-accent-amber text-xs font-medium">
                    Uncommitted
                  </span>
                </div>
              </div>
              <div className="my-1.5 border-t border-white/5" />
              <div className="text-text-secondary mb-2 px-2 pt-1 text-[10px] font-bold tracking-wider uppercase">
                Actions
              </div>
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  className="text-text-primary flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-white/5"
                >
                  Switch Execution Root
                </button>
                <button
                  type="button"
                  className="text-text-primary flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-white/5"
                >
                  Change Git Mode
                </button>
                <button
                  type="button"
                  className="text-text-primary flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-white/5"
                >
                  Rebind Session
                </button>
              </div>
            </div>
          </Popover>
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
          leadingIcon={<CheckCircle2 className="h-4 w-4" />}
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
    </motion.header>
  );
}
