import { ArrowDown, ArrowUp, TagIcon } from "lucide-react";

import {
  getBucketLabel,
  getBucketTone,
} from "@/components/project/settings/projectSettings.constants";
import type {
  EditableStatus,
  StatusBucket,
} from "@/components/project/settings/projectSettings.types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";

type TaskStatusesSectionProps = {
  readonly statuses: ReadonlyArray<EditableStatus>;
  readonly newStatusName: string;
  readonly onStatusNameChange: (statusId: string, name: string) => void;
  readonly onStatusBucketChange: (
    statusId: string,
    bucket: StatusBucket,
  ) => void;
  readonly onMoveStatus: (statusId: string, direction: "up" | "down") => void;
  readonly onDeleteStatus: (statusId: string) => void;
  readonly onNewStatusNameChange: (value: string) => void;
  readonly onAddStatus: () => void;
};

export function TaskStatusesSection({
  statuses,
  newStatusName,
  onStatusNameChange,
  onStatusBucketChange,
  onMoveStatus,
  onDeleteStatus,
  onNewStatusNameChange,
  onAddStatus,
}: TaskStatusesSectionProps) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <TagIcon className="text-accent-violet h-4 w-4" />
        <h3 className="text-text-primary font-display text-sm font-medium">
          Task Statuses
        </h3>
      </div>

      <div className="bg-canvas-subtle/50 flex flex-col gap-3 rounded-2xl border border-white/5 p-4">
        {statuses.map((status, index) => (
          <div
            key={status.id}
            className="bg-canvas/50 flex items-center gap-3 rounded-2xl border border-white/5 px-3 py-3"
          >
            <div className="flex flex-col gap-1">
              <IconButton
                icon={<ArrowUp className="h-3.5 w-3.5" />}
                variant="subtle"
                aria-label={`Move ${status.name} up`}
                onClick={() => onMoveStatus(status.id, "up")}
                disabled={index === 0}
              />
              <IconButton
                icon={<ArrowDown className="h-3.5 w-3.5" />}
                variant="subtle"
                aria-label={`Move ${status.name} down`}
                onClick={() => onMoveStatus(status.id, "down")}
                disabled={index === statuses.length - 1}
              />
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={status.name}
                  onChange={event =>
                    onStatusNameChange(status.id, event.target.value)
                  }
                  className="text-text-primary bg-canvas focus:border-accent-blue/40 min-w-0 flex-1 rounded-xl border border-white/10 px-3 py-2 text-sm transition-colors outline-none"
                />
                <Badge tone={getBucketTone(status.bucket)}>
                  {getBucketLabel(status.bucket)}
                </Badge>
              </div>

              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-text-tertiary">Bucket</span>
                  <select
                    value={status.bucket}
                    onChange={event =>
                      onStatusBucketChange(
                        status.id,
                        event.target.value as StatusBucket,
                      )
                    }
                    className="text-text-primary bg-canvas focus:border-accent-blue/40 rounded-lg border border-white/10 px-2.5 py-1.5 text-sm transition-colors outline-none"
                  >
                    <option value="todo">To Do</option>
                    <option value="in_progress">In Progress</option>
                    <option value="done">Done</option>
                  </select>
                </label>

                <button
                  type="button"
                  onClick={() => onDeleteStatus(status.id)}
                  className="text-text-tertiary hover:text-accent-red text-sm font-medium transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}

        <div className="flex items-center gap-2 rounded-2xl border border-dashed border-white/10 px-3 py-3">
          <input
            type="text"
            value={newStatusName}
            onChange={event => onNewStatusNameChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault();
                onAddStatus();
              }
            }}
            placeholder="Add status..."
            className="text-text-primary placeholder:text-text-tertiary/50 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <Button variant="secondary" size="sm" onClick={onAddStatus}>
            Add status
          </Button>
        </div>
      </div>
    </section>
  );
}
