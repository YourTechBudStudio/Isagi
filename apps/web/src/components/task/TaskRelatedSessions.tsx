import { RefreshCw } from "lucide-react";
import { useNavigate } from "react-router";

import type { MockOpenSession } from "@/lib/mock/project.mock";

type TaskRelatedSessionsProps = {
  readonly sessions: ReadonlyArray<MockOpenSession>;
  readonly title?: string;
};

export function TaskRelatedSessions({
  sessions,
  title = "Related sessions",
}: TaskRelatedSessionsProps) {
  const navigate = useNavigate();

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
        {title}
      </span>

      <div className="flex flex-col gap-0.5 overflow-hidden rounded-xl border border-white/5">
        {sessions.map(session => (
          <div
            key={session.id}
            className="flex items-center justify-between px-3.5 py-2.5 transition-colors hover:bg-white/2"
          >
            <span className="text-text-secondary text-sm">{session.label}</span>
            <button
              type="button"
              onClick={() => navigate(`/session/${session.id}`)}
              className="text-text-tertiary hover:text-text-primary flex items-center gap-1.5 text-xs font-medium transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              Resume
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
