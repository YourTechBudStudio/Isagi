import type { LucideIcon } from "lucide-react";
import { CircleDashed, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import type { SessionKind, SessionState } from "@/lib/mock/sidebar.mock";

type SidebarSessionItemProps = {
  readonly title: string;
  readonly state: SessionState;
  readonly kind?: SessionKind;
  readonly isActiveRoute?: boolean;
};

// Maps session states to Catppuccin styles for Apple-like indicators
const statusConfig: Record<
  SessionState,
  {
    icon?: LucideIcon;
    iconClassName?: string;
    containerClassName: string;
  }
> = {
  waiting: {
    // For waiting, we use a custom SVG for a concentric dot instead of a standard Lucide icon
    containerClassName:
      "hover:bg-white/[0.04] border border-transparent hover:border-white/[0.03]",
  },
  active: {
    icon: Loader2,
    iconClassName: "text-spark animate-spin", // Standard smooth spin
    containerClassName:
      "hover:bg-white/[0.04] border border-transparent hover:border-white/[0.03]",
  },
  idle: {
    icon: CircleDashed,
    iconClassName: "text-text-tertiary",
    containerClassName: "opacity-70 hover:opacity-100 transition-opacity",
  },
};

export function SidebarSessionItem({
  title,
  state,
  kind = "task",
  isActiveRoute,
}: SidebarSessionItemProps) {
  const config = statusConfig[state];
  const StatusIcon = config.icon;
  const isScratch = kind === "scratch";

  return (
    <button
      className={cn(
        "group relative flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-all duration-300",
        config.containerClassName,
        // Active Route overriding styles (Elevated look)
        isActiveRoute &&
          "bg-canvas-elevated border-white/5 opacity-100 shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]",
        !isActiveRoute && "hover:bg-white/3",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="flex h-4 w-4 shrink-0 items-center justify-center">
          {state === "waiting" ? (
            <div className="relative flex h-3 w-3 items-center justify-center">
              {/* Outer pulsing ring */}
              <div
                className="border-accent-amber/40 absolute inset-0 animate-ping rounded-full border"
                style={{ animationDuration: "3s" }}
              />
              {/* Inner subtle dot */}
              <div className="bg-accent-amber/80 h-1.5 w-1.5 rounded-full" />
            </div>
          ) : (
            StatusIcon && (
              <StatusIcon className={cn("h-3.5 w-3.5", config.iconClassName)} />
            )
          )}
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
      {isScratch && (
        <span className="text-accent-cyan bg-accent-cyan/8 ml-2 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] leading-tight font-medium">
          Scratch
        </span>
      )}
    </button>
  );
}
