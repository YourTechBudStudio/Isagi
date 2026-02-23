import { PenTool } from "lucide-react";

import { cn } from "@/lib/cn";
import type { SidebarTriage } from "@/lib/mock/sidebar.mock";

type SidebarTriageSectionProps = {
  readonly items: ReadonlyArray<SidebarTriage>;
};

export function SidebarTriageSection({ items }: SidebarTriageSectionProps) {
  // CRITICAL RULE: We only show triage sessions in the sidebar if the user
  // has interacted with them at least once. This prevents the sidebar from
  // being flooded with auto-proposed sparks that haven't been reviewed.
  const interactedItems = items.filter(item => item.hasInteracted);

  if (interactedItems.length === 0) return null;

  return (
    <div className="relative mb-10">
      <h3 className="text-text-primary mb-3 flex items-center gap-2 px-3 text-[10px] font-semibold tracking-widest uppercase opacity-90">
        <div className="bg-accent-violet/80 h-1.5 w-1.5 animate-pulse rounded-full shadow-[0_0_8px_rgba(198,160,246,0.6)]" />
        Active Triage
      </h3>

      <div className="space-y-0.5">
        {interactedItems.map(item => (
          <button
            key={item.id}
            className={cn(
              "group relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm transition-all duration-300",
              item.isActiveRoute
                ? "bg-canvas-elevated text-text-primary border border-white/[0.05] font-medium shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]"
                : "text-text-secondary hover:text-text-primary border border-transparent hover:bg-white/[0.03]",
            )}
          >
            <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
              <PenTool className="text-accent-violet h-3.5 w-3.5" />
            </div>
            <span className="truncate">{item.title}</span>
          </button>
        ))}
      </div>

      {/* Subtle bottom separator to distinguish Triage from Projects */}
      <div className="absolute right-3 -bottom-5 left-3 h-px bg-gradient-to-r from-transparent via-white/5 to-transparent" />
    </div>
  );
}
