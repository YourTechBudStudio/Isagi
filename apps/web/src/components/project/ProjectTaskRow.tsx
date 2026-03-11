import { Play, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { MockTask } from "@/lib/mock/project.mock";

type ProjectTaskRowProps = {
  readonly task: MockTask;
};

export function ProjectTaskRow({ task }: ProjectTaskRowProps) {
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

  const renderSessionAffordance = () => {
    if (task.sessionState === "active") {
      return (
        <div className="bg-accent-violet/10 border-accent-violet/20 flex items-center gap-2 rounded-full border px-3 py-1.5">
          <div className="bg-accent-violet h-2 w-2 animate-pulse rounded-full" />
          <span className="text-accent-violet text-xs font-medium">Active</span>
        </div>
      );
    }

    if (task.sessionState === "resume") {
      return (
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<RefreshCw className="h-3.5 w-3.5" />}
          className="opacity-0 transition-opacity group-hover:opacity-100"
          onClick={() => navigate(`/session/${task.id}`)}
        >
          Resume
        </Button>
      );
    }

    return (
      <Button
        variant="secondary"
        size="sm"
        leadingIcon={<Play className="h-3.5 w-3.5" />}
        className="opacity-0 transition-opacity group-hover:opacity-100"
        onClick={() => navigate(`/session/${task.id}`)}
      >
        Start
      </Button>
    );
  };

  return (
    <div className="group flex cursor-pointer items-center justify-between border-b border-white/5 py-3 pr-2 pl-4 transition-colors hover:bg-white/[0.02]">
      <div className="flex items-center gap-4">
        <span className="text-text-primary text-sm font-medium">
          {task.title}
        </span>
        <div className="flex items-center gap-2">
          <Badge tone={getPriorityColor(task.priority)}>{task.priority}</Badge>
          {task.labels.map(label => (
            <Badge key={label} tone="neutral">
              {label}
            </Badge>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-4">
        {task.dueDate && (
          <span className="text-text-tertiary font-mono text-xs">
            {task.dueDate}
          </span>
        )}
        <div className="flex w-24 justify-end">{renderSessionAffordance()}</div>
      </div>
    </div>
  );
}
