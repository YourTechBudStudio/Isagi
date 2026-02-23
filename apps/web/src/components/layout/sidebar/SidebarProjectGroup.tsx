import { useState } from "react";

import type { SidebarProject } from "@/lib/mock/sidebar.mock";

import { SidebarSessionItem } from "./SidebarSessionItem";

type SidebarProjectGroupProps = {
  readonly project: SidebarProject;
};

// We enforce a strict display limit. Expanding reveals the next 5.
const SESSIONS_PER_PAGE = 5;

// Weight lookup for sorting: waiting (0) > active (1) > idle (2)
const STATE_WEIGHT: Record<string, number> = {
  waiting: 0,
  active: 1,
  idle: 2,
};

export function SidebarProjectGroup({ project }: SidebarProjectGroupProps) {
  const [expandedCount, setExpandedCount] = useState(SESSIONS_PER_PAGE);

  // 1. Sort sessions strictly by priority weight
  const sortedSessions = [...project.sessions].sort(
    (a, b) => STATE_WEIGHT[a.state] - STATE_WEIGHT[b.state],
  );

  // 2. Slice to the currently visible amount
  const visibleSessions = sortedSessions.slice(0, expandedCount);
  const remainingCount = sortedSessions.length - expandedCount;

  return (
    <div className="mb-8 last:mb-0">
      <h3 className="text-text-tertiary mb-3 flex items-center gap-2 px-3 text-[10px] font-semibold tracking-widest uppercase">
        {project.name}
      </h3>

      <div className="relative space-y-0.5">
        {visibleSessions.map(session => (
          <SidebarSessionItem
            key={session.id}
            title={session.title}
            state={session.state}
            statusText={session.statusText}
            isActiveRoute={session.isActiveRoute}
          />
        ))}

        {remainingCount > 0 && (
          <button
            onClick={() => setExpandedCount(prev => prev + SESSIONS_PER_PAGE)}
            className="text-text-tertiary hover:text-text-secondary mt-1 w-full rounded-xl px-3 py-2.5 text-left text-xs font-medium transition-colors hover:bg-white/[0.02]"
          >
            Show {Math.min(remainingCount, SESSIONS_PER_PAGE)} more...
          </button>
        )}
      </div>
    </div>
  );
}
