import type { LucideIcon } from "lucide-react";
import { AlertCircle, CircleDashed, Play } from "lucide-react";

import { cn } from "@/lib/cn";
import type { SessionState } from "@/lib/mock/sidebar.mock";

type SidebarSessionItemProps = {
  readonly title: string;
  readonly state: SessionState;
  readonly statusText?: string;
  readonly isActiveRoute?: boolean;
};

// Maps session states to Catppuccin styles for Apple-like indicators
const statusConfig: Record<
  SessionState,
  {
    icon: LucideIcon;
    iconClassName: string;
    chipClassName: string;
    containerClassName: string;
  }
> = {
  waiting: {
    icon: AlertCircle,
    iconClassName: "text-accent-red animate-pulse", // Gentle pulse for waiting
    chipClassName: "bg-accent-red/10 text-accent-red",
    containerClassName:
      "hover:bg-white/[0.04] border border-transparent hover:border-white/[0.03]",
  },
  active: {
    icon: Play,
    iconClassName: "text-spark animate-spin-slow fill-spark/20", // Custom slow spin
    chipClassName: "bg-spark/10 text-spark",
    containerClassName:
      "hover:bg-white/[0.04] border border-transparent hover:border-white/[0.03]",
  },
  idle: {
    icon: CircleDashed,
    iconClassName: "text-text-tertiary",
    chipClassName: "hidden", // We usually don't show a chip for idle
    containerClassName: "opacity-70 hover:opacity-100 transition-opacity",
  },
};

export function SidebarSessionItem({
  title,
  state,
  statusText,
  isActiveRoute,
}: SidebarSessionItemProps) {
  const config = statusConfig[state];
  const StatusIcon = config.icon;

  return (
    <button
      className={cn(
        "group relative flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-all duration-300",
        config.containerClassName,
        // Active Route overriding styles (Elevated look)
        isActiveRoute &&
          "bg-canvas-elevated border-white/[0.05] opacity-100 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]",
        !isActiveRoute && "hover:bg-white/[0.03]",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          <StatusIcon className={cn("h-3.5 w-3.5", config.iconClassName)} />
        </div>
        <span
          className={cn(
            "truncate transition-colors",
            isActiveRoute
              ? "text-text-primary font-medium"
              : "text-text-secondary group-hover:text-text-primary",
          )}
        >
          {title}
        </span>
      </div>

      {statusText && state !== "idle" && (
        <span
          className={cn(
            "ml-2 flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide shadow-sm",
            config.chipClassName,
          )}
        >
          {statusText}
        </span>
      )}
    </button>
  );
}
