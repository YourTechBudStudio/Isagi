import { cn } from "@/lib/cn";
import type { SidebarProject, SidebarTriage } from "@/lib/mock/sidebar.mock";

import { SidebarProjectGroup } from "./sidebar/SidebarProjectGroup";
import { SidebarTriageSection } from "./sidebar/SidebarTriageSection";

type ContextSidebarProps = {
  readonly triageItems?: ReadonlyArray<SidebarTriage>;
  readonly projects?: ReadonlyArray<SidebarProject>;
  readonly footerLabel?: string;
  readonly footerInitial?: string;
  readonly className?: string;
};

export function ContextSidebar({
  triageItems = [],
  projects = [],
  footerLabel = "Isagi Core",
  footerInitial = "I",
  className,
}: ContextSidebarProps) {
  return (
    <aside
      className={cn(
        "bg-canvas fixed top-0 left-0 z-20 flex h-dvh w-[var(--layout-sidebar-width)] shrink-0 flex-col justify-between border-r border-white/5",
        className,
      )}
    >
      <div className="custom-scrollbar flex-1 overflow-x-hidden overflow-y-auto p-3">
        <SidebarTriageSection items={triageItems} />

        <div className="flex flex-col gap-6">
          {projects.map(project => (
            <SidebarProjectGroup key={project.id} project={project} />
          ))}
        </div>
      </div>

      <div className="bg-canvas/80 text-text-secondary hover:text-text-primary group relative z-20 flex shrink-0 cursor-pointer items-center gap-3 border-t border-white/5 px-5 py-4 text-sm backdrop-blur-xl transition-colors">
        <div className="bg-canvas-elevated flex h-8 w-8 items-center justify-center rounded-full border border-white/5 shadow-sm transition-colors group-hover:border-white/10">
          {footerInitial}
        </div>
        <span className="font-medium">{footerLabel}</span>
      </div>
    </aside>
  );
}
