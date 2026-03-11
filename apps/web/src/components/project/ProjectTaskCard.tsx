import { Play, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router";

import { Badge } from "@/components/ui/Badge";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import type { MockTask } from "@/lib/mock/project.mock";

type ProjectTaskCardProps = {
  readonly task: MockTask;
};

export function ProjectTaskCard({ task }: ProjectTaskCardProps) {
  const navigate = useNavigate();

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "high":
        return "red";
      case "medium":
        return "amber";
      case "low":
        return "blue";
      default:
        return "neutral";
    }
  };

  const renderSessionIndicator = () => {
    if (task.sessionState === "active") {
      return (
        <div className="flex items-center gap-1.5" title="Session Active">
          <div className="bg-accent-violet h-2 w-2 animate-pulse rounded-full" />
          <span className="text-accent-violet text-[10px] font-medium tracking-wider uppercase">
            Active
          </span>
        </div>
      );
    }
    if (task.sessionState === "resume") {
      return (
        <div
          className="text-text-tertiary hover:text-text-secondary flex items-center gap-1.5 transition-colors"
          title="Resume Session"
        >
          <RefreshCw className="h-3 w-3" />
          <span className="text-[10px] font-medium tracking-wider uppercase">
            Resume
          </span>
        </div>
      );
    }
    return (
      <div
        className="text-text-tertiary hover:text-text-secondary flex items-center gap-1.5 transition-colors"
        title="Start Session"
      >
        <Play className="h-3 w-3" />
        <span className="text-[10px] font-medium tracking-wider uppercase">
          Start
        </span>
      </div>
    );
  };

  return (
    <SurfaceCard
      tone="elevated"
      interactive
      className="group flex cursor-pointer flex-col gap-3 p-4 hover:border-white/10"
      onClick={() => navigate(`/session/${task.id}`)}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-text-primary text-sm leading-snug font-medium">
          {task.title}
        </h4>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={getPriorityColor(task.priority)}>{task.priority}</Badge>
        {task.labels.map(label => (
          <Badge key={label} tone="neutral">
            {label}
          </Badge>
        ))}
      </div>

      <div className="mt-1 flex items-center justify-between border-t border-white/5 pt-3">
        {task.dueDate ? (
          <span className="text-text-tertiary font-mono text-xs">
            {task.dueDate}
          </span>
        ) : (
          <span />
        )}
        {renderSessionIndicator()}
      </div>
    </SurfaceCard>
  );
}
