import { Play, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { MockTask } from "@/lib/mock/project.mock";
import { getDueDateColor, getPriorityColor } from "@/lib/utils/task-utils";

type ProjectTaskRowProps = {
  readonly task: MockTask;
};

export function ProjectTaskRow({ task }: ProjectTaskRowProps) {
  const navigate = useNavigate();

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
          className="border-transparent bg-white/[0.04] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.08]"
          onClick={e => {
            e.stopPropagation();
            navigate(`/session/${task.id}`);
          }}
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
        className="border-transparent bg-white/[0.04] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.08]"
        onClick={e => {
          e.stopPropagation();
          navigate(`/session/${task.id}`);
        }}
      >
        Start
      </Button>
    );
  };

  return (
    <div
      className="group flex cursor-pointer items-center justify-between rounded-2xl px-4 py-3.5 transition-all duration-300 hover:bg-white/[0.03] active:scale-[0.995]"
      onClick={() => navigate(`/session/${task.id}`)}
    >
      <div className="flex items-center gap-5">
        <span className="text-text-primary text-[15px] font-medium tracking-tight">
          {task.title}
        </span>
        <div className="flex items-center gap-2 opacity-80 transition-opacity group-hover:opacity-100">
          <Badge tone={getPriorityColor(task.priority)}>{task.priority}</Badge>
          {task.labels.map(label => (
            <Badge
              key={label}
              tone="neutral"
              className="border-white/5 bg-transparent"
            >
              {label}
            </Badge>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-6">
        {task.dueDate && (
          <span
            className={cn(
              "font-mono text-[13px] tracking-wide",
              getDueDateColor(task.dueDate),
            )}
          >
            {task.dueDate}
          </span>
        )}
        <div className="flex w-28 justify-end">{renderSessionAffordance()}</div>
      </div>
    </div>
  );
}
