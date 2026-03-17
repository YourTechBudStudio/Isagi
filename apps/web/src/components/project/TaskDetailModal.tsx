import { AnimatePresence, motion } from "framer-motion";

import { TaskDetailModalContent } from "@/components/project/TaskDetailModalContent";
import type { MockTask } from "@/lib/mock/project.mock";

type TaskDetailModalProps = {
  readonly taskId: string | null;
  readonly tasks: ReadonlyArray<MockTask>;
  readonly availableLabels: ReadonlyArray<string>;
  readonly collectionOptions: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onUpdateTask: (task: MockTask) => void;
};

export function TaskDetailModal({
  taskId,
  tasks,
  availableLabels,
  collectionOptions,
  onClose,
  onUpdateTask,
}: TaskDetailModalProps) {
  const task = tasks.find(candidateTask => candidateTask.id === taskId);

  if (!task && taskId) {
    return null;
  }

  return (
    <AnimatePresence>
      {task ? (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="bg-canvas/50 fixed inset-0 z-50 backdrop-blur-sm"
            onClick={onClose}
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{
              type: "spring",
              damping: 22,
              stiffness: 260,
              mass: 0.8,
            }}
            className="bg-canvas-elevated fixed inset-0 z-50 m-auto flex h-fit max-h-[85vh] w-130 max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
          >
            <TaskDetailModalContent
              task={task}
              availableLabels={availableLabels}
              collectionOptions={collectionOptions}
              onClose={onClose}
              onUpdateTask={onUpdateTask}
            />
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}
