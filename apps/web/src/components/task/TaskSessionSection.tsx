import { Play, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { MockTask } from "@/lib/mock/project.mock";
import { getTaskSessionState } from "@/lib/task-session";

type TaskSessionSectionProps = {
  readonly task: MockTask;
  readonly variant: "modal" | "panel";
};

export function TaskSessionSection({ task, variant }: TaskSessionSectionProps) {
  const navigate = useNavigate();
  const { activeSiblingSessions, ctaConfig, secondarySessions } =
    getTaskSessionState(task);

  const renderSessionList = (
    sessions: ReadonlyArray<(typeof task.openSessions)[number]>,
    title: string,
  ) => {
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
              <span className="text-text-secondary text-sm">
                {session.label}
              </span>
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
  };

  if (variant === "panel") {
    return renderSessionList(activeSiblingSessions, "Active sibling sessions");
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Button
        variant={ctaConfig.variant}
        size="md"
        className={cn("w-full", ctaConfig.accentClass)}
        onClick={() => navigate(`/session/${ctaConfig.sessionId}`)}
      >
        {ctaConfig.iconKind === "active" ? (
          <div className="bg-accent-violet h-2 w-2 animate-pulse rounded-full" />
        ) : ctaConfig.iconKind === "resume" ? (
          <RefreshCw className="h-3.5 w-3.5" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}
        {ctaConfig.label}
      </Button>

      {renderSessionList(secondarySessions, "Other sessions")}
    </div>
  );
}
