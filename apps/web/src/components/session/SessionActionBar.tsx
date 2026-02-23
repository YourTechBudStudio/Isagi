import { motion, useMotionValueEvent, useScroll } from "framer-motion";
import {
  CheckCircle2,
  ChevronRight,
  Code2,
  GitBranch,
  PanelRight,
  Terminal,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";

type SessionActionBarProps = {
  readonly breadcrumbs: ReadonlyArray<string>;
  readonly currentContext: string;
  readonly branchName: string;
  readonly isArtifactsOpen: boolean;
  readonly onToggleArtifacts: () => void;
};

export function SessionActionBar({
  breadcrumbs,
  currentContext,
  branchName,
  isArtifactsOpen,
  onToggleArtifacts,
}: SessionActionBarProps) {
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);

  useMotionValueEvent(scrollY, "change", latest => {
    const previous = scrollY.getPrevious() ?? 0;
    if (latest > previous && latest > 50) {
      setHidden(true);
    } else {
      setHidden(false);
    }
  });

  const headerClassName = cn(
    "pointer-events-none fixed top-6 z-30 flex items-center justify-between",
    "left-[calc(var(--layout-sidebar-width)+1.5rem)]",
    isArtifactsOpen
      ? "right-[calc(var(--layout-panel-width)+1.5rem)]"
      : "right-6",
  );

  return (
    <motion.header
      variants={{
        visible: { y: 0 },
        hidden: { y: "-150%" },
      }}
      animate={hidden ? "hidden" : "visible"}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
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
      </div>

      <div className="bg-canvas-elevated/80 pointer-events-auto flex items-center gap-3 rounded-2xl border border-white/10 p-1.5 shadow-lg backdrop-blur-md">
        <div className="flex items-center gap-2 border-r border-white/10 px-3 py-1">
          <GitBranch className="text-text-secondary h-4 w-4" />
          <span className="text-text-secondary font-mono text-sm">
            {branchName}
          </span>
          <div
            className="bg-accent-amber ml-1 h-1.5 w-1.5 animate-pulse rounded-full"
            title="Uncommitted changes"
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
          leadingIcon={<CheckCircle2 className="h-4 w-4" />}
          className="bg-accent-violet hover:bg-accent-violet/90 text-canvas ml-1"
        >
          Complete Task
        </Button>

        <div className="ml-1 border-l border-white/10 pl-1">
          <IconButton
            icon={<PanelRight className="h-4 w-4" />}
            onClick={onToggleArtifacts}
            title="Toggle Artifacts"
            className={cn(isArtifactsOpen && "text-text-primary bg-white/5")}
          />
        </div>
      </div>
    </motion.header>
  );
}
