import { Play, RefreshCw } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { MockTask } from "@/lib/mock/project.mock";
import { getPrimaryOpenSession } from "@/lib/task-session";
import { TASK_PRIORITY_META } from "@/lib/task-ui";
import { getDueDateColor } from "@/lib/utils/task-utils";

type ProjectTaskRowProps = {
  readonly task: MockTask;
};

export function ProjectTaskRow({ task }: ProjectTaskRowProps) {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();

  const handleOpenSheet = () => {
    setSearchParams({ taskId: task.id });
  };

  const handleStartSession = (e: React.MouseEvent) => {
    e.stopPropagation();
    const primarySession = getPrimaryOpenSession(task.openSessions);
    navigate(`/session/${primarySession?.id ?? task.id}`);
  };

  const renderSessionAffordance = () => {
    const primarySession = getPrimaryOpenSession(task.openSessions);

    if (primarySession?.isActive) {
      return (
        <div
          className="bg-accent-violet/10 border-accent-violet/20 flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5"
          onClick={handleStartSession}
        >
          <div className="bg-accent-violet h-2 w-2 animate-pulse rounded-full" />
          <span className="text-accent-violet text-xs font-medium">Active</span>
        </div>
      );
    }

    if (primarySession) {
      return (
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<RefreshCw className="h-3.5 w-3.5" />}
          className="border-transparent bg-white/4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/8"
          onClick={handleStartSession}
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
        className="border-transparent bg-white/4 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/8"
        onClick={handleStartSession}
      >
        Start
      </Button>
    );
  };

  return (
    <div
      className="group flex cursor-pointer items-center justify-between border-b border-white/5 px-4 py-3 transition-colors duration-200 last:border-b-0 hover:bg-white/2"
      onClick={handleOpenSheet}
    >
      <div className="flex items-center gap-5">
        <span className="text-text-primary text-[14px] font-medium tracking-tight">
          {task.title}
        </span>
        <div className="flex items-center gap-2 opacity-80 transition-opacity group-hover:opacity-100">
          <Badge tone={TASK_PRIORITY_META[task.priority].tone}>
            {task.priority}
          </Badge>
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
