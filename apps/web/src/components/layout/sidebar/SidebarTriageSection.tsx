import type { SidebarTriage } from "@/lib/mock/sidebar.mock";

import { SidebarSessionItem } from "./SidebarSessionItem";

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
          <SidebarSessionItem
            key={item.id}
            title={item.title}
            state={item.state}
            isActiveRoute={item.isActiveRoute}
          />
        ))}
      </div>

      {/* Subtle bottom separator to distinguish Triage from Projects */}
      <div className="absolute right-3 -bottom-5 left-3 h-px bg-gradient-to-r from-transparent via-white/5 to-transparent" />
    </div>
  );
}
