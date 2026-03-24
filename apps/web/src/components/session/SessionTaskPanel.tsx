import { TaskEditor } from "@/components/task/TaskEditor";
import { TaskSessionSection } from "@/components/task/TaskSessionSection";
import type { MockTask } from "@/lib/mock/project.mock";

type SessionTaskPanelProps = {
  readonly task: MockTask;
  readonly availableLabels: ReadonlyArray<string>;
  readonly collectionOptions: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onUpdateTask: (task: MockTask) => void;
};

export function SessionTaskPanel({
  task,
  availableLabels,
  collectionOptions,
  onClose,
  onUpdateTask,
}: SessionTaskPanelProps) {
  const beforeMetadata =
    task.status === "done" ? (
      <div className="bg-canvas-subtle/50 text-text-tertiary rounded-xl border border-white/5 px-4 py-3 text-center text-sm">
        Task complete. Change status to reopen.
      </div>
    ) : null;

  const afterNotes =
    task.status === "done" ? null : (
      <TaskSessionSection task={task} variant="panel" />
    );

  return (
    <TaskEditor
      task={task}
      availableLabels={availableLabels}
      collectionOptions={collectionOptions}
      onClose={onClose}
      onUpdateTask={onUpdateTask}
      beforeMetadata={beforeMetadata}
      afterNotes={afterNotes}
      closeButtonVariant="subtle"
    />
  );
}
