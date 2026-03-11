import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

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
  const [isCollapsed, setIsCollapsed] = useState(false);
  const navigate = useNavigate();

  // 1. Sort sessions strictly by priority weight
  const sortedSessions = [...project.sessions].sort(
    (a, b) => STATE_WEIGHT[a.state] - STATE_WEIGHT[b.state],
  );

  // 2. Slice to the currently visible amount
  const visibleSessions = sortedSessions.slice(0, expandedCount);
  const remainingCount = sortedSessions.length - expandedCount;

  // 3. Determine if we have hidden waiting sessions
  const hasWaitingSessions = project.sessions.some(s => s.state === "waiting");

  return (
    <div className="mb-8 last:mb-0">
      <div className="text-text-tertiary group mb-2 flex w-full items-center gap-1.5 px-3 text-[10px] font-semibold tracking-widest uppercase">
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="text-text-tertiary/50 hover:text-text-tertiary flex h-4 w-4 cursor-pointer items-center justify-center transition-colors"
        >
          {isCollapsed ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>
        <button
          onClick={() => navigate(`/project/${project.id}`)}
          className="hover:text-text-secondary flex flex-1 cursor-pointer items-center gap-2 text-left transition-colors"
        >
          {project.name}
          {isCollapsed && hasWaitingSessions && (
            <div className="bg-accent-amber h-1.5 w-1.5 animate-pulse rounded-full" />
          )}
        </button>
      </div>

      {!isCollapsed && (
        <div className="relative space-y-0.5">
          {visibleSessions.map(session => (
            <SidebarSessionItem
              key={session.id}
              title={session.title}
              state={session.state}
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
      )}
    </div>
  );
}
