import type { ReactNode } from "react";

import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { cn } from "@/lib/cn";

type FocusQueueItemProps = {
  readonly title: string;
  readonly project: string;
  readonly action?: ReactNode;
  readonly badge?: ReactNode;
  readonly hoverAccent?: "green" | "cyan";
  readonly className?: string;
};

export function FocusQueueItem({
  title,
  project,
  action,
  badge,
  hoverAccent = "green",
  className,
}: FocusQueueItemProps) {
  return (
    <SurfaceCard
      tone="elevated"
      interactive
      className={cn(
        "group flex cursor-pointer items-center justify-between p-5 shadow-sm hover:border-white/[0.08] hover:bg-white/[0.04]",
        className,
      )}
    >
      <div className="flex flex-col">
        <div className="mb-1 flex items-center gap-2.5">
          <span
            className={cn(
              "text-[15px] font-medium transition-colors",
              hoverAccent === "cyan"
                ? "group-hover:text-accent-cyan"
                : "group-hover:text-accent-green",
            )}
          >
            {title}
          </span>
          {badge}
        </div>
        <span className="text-text-tertiary text-xs font-medium tracking-wide uppercase">
          Project: {project}
        </span>
      </div>
      {action}
    </SurfaceCard>
  );
}
