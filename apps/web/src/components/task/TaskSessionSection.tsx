import { Play, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router";

import { TaskRelatedSessions } from "@/components/task/TaskRelatedSessions";
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

  if (variant === "panel") {
    return (
      <TaskRelatedSessions
        sessions={activeSiblingSessions}
        title="Active sibling sessions"
      />
    );
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

      <TaskRelatedSessions
        sessions={secondarySessions}
        title="Other sessions"
      />
    </div>
  );
}
