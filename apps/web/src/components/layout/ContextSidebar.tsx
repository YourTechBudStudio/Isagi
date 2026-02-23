import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";

type SidebarItemState = "default" | "active" | "highlighted";

type SidebarItem = {
  readonly id: string;
  readonly label: string;
  readonly state?: SidebarItemState;
};

type ContextSidebarProps = {
  readonly items: ReadonlyArray<SidebarItem>;
  readonly heading?: string;
  readonly footerLabel?: string;
  readonly footerInitial?: string;
  readonly className?: string;
};

const itemClassByState: Record<SidebarItemState, string> = {
  active:
    "group flex w-full items-center justify-between rounded-xl border border-white/[0.03] bg-white/[0.04] px-3 py-2.5 text-left text-sm shadow-sm transition-all duration-300 hover:bg-white/[0.06]",
  highlighted:
    "text-accent-violet group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-all duration-300",
  default:
    "text-text-secondary group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition-all duration-300 hover:bg-white/[0.03]",
};

export function ContextSidebar({
  items,
  heading = "Active Context",
  footerLabel = "Isagi Core",
  footerInitial = "I",
  className,
}: ContextSidebarProps) {
  return (
    <aside
      className={cn(
        "bg-canvas fixed top-0 left-0 z-20 flex h-dvh w-[var(--layout-sidebar-width)] shrink-0 flex-col justify-between border-r border-white/5 p-5",
        className,
      )}
    >
      <div>
        <div className="mb-10">
          <h3 className="text-text-tertiary mb-4 flex items-center gap-2 text-xs font-semibold tracking-wider uppercase">
            <div className="bg-accent-green/80 h-1.5 w-1.5 rounded-full shadow-[0_0_8px_rgba(166,218,149,0.8)]" />
            {heading}
          </h3>
          <div className="space-y-1.5">
            {items.map(item => {
              const state = item.state ?? "default";

              return (
                <button key={item.id} className={itemClassByState[state]}>
                  <span
                    className={cn(
                      "truncate pr-2",
                      (state === "active" || state === "highlighted") &&
                        "font-medium",
                    )}
                  >
                    {item.label}
                  </span>
                  {state === "active" ? (
                    <ChevronRight className="text-text-tertiary h-4 w-4 -translate-x-1 opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="text-text-secondary hover:text-text-primary group flex cursor-pointer items-center gap-3 px-2 py-2 text-sm transition-colors">
        <div className="bg-canvas-elevated flex h-8 w-8 items-center justify-center rounded-full border border-white/5 shadow-sm transition-colors group-hover:border-white/10">
          {footerInitial}
        </div>
        <span className="font-medium">{footerLabel}</span>
      </div>
    </aside>
  );
}
