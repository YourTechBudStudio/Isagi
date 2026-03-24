import { TaskEditor } from "@/components/task/TaskEditor";
import { TaskSessionSection } from "@/components/task/TaskSessionSection";
import type { MockTask } from "@/lib/mock/project.mock";

type TaskDetailModalContentProps = {
  readonly task: MockTask;
  readonly availableLabels: ReadonlyArray<string>;
  readonly collectionOptions: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onUpdateTask: (task: MockTask) => void;
};

export function TaskDetailModalContent({
  task,
  availableLabels,
  collectionOptions,
  onClose,
  onUpdateTask,
}: TaskDetailModalContentProps) {
  const beforeMetadata =
    task.status === "done" ? (
      <div className="bg-canvas-subtle/50 text-text-tertiary rounded-xl border border-white/5 px-4 py-3 text-center text-sm">
        Task complete. Change status to reopen.
      </div>
    ) : (
      <TaskSessionSection task={task} variant="modal" />
    );

  return (
    <TaskEditor
      task={task}
      availableLabels={availableLabels}
      collectionOptions={collectionOptions}
      onClose={onClose}
      onUpdateTask={onUpdateTask}
      beforeMetadata={beforeMetadata}
      enableEscapeClose
    />
  );
}
