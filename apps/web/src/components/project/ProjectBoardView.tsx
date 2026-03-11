import { motion } from "framer-motion";

import type { MockTask, TaskStatus } from "@/lib/mock/project.mock";

import { ProjectTaskCard } from "./ProjectTaskCard";

type ProjectBoardViewProps = {
  readonly tasks: ReadonlyArray<MockTask>;
};

const COLUMNS: Array<{ id: TaskStatus; label: string }> = [
  { id: "todo", label: "To Do" },
  { id: "in_progress", label: "In Progress" },
  { id: "done", label: "Done" },
];

export function ProjectBoardView({ tasks }: ProjectBoardViewProps) {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
      },
    },
  };

  const columnVariants = {
    hidden: { opacity: 0, y: 16 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.5 },
    },
  };

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="custom-scrollbar flex h-full gap-6 overflow-x-auto pt-4 pb-8"
    >
      {COLUMNS.map(col => {
        const columnTasks = tasks.filter(t => t.status === col.id);
        return (
          <motion.div
            key={col.id}
            variants={columnVariants}
            className="flex w-80 shrink-0 flex-col gap-4"
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-text-primary font-display text-sm font-semibold tracking-tight">
                {col.label}
              </h3>
              <span className="bg-canvas-elevated text-text-tertiary flex h-6 w-6 items-center justify-center rounded-full border border-white/5 text-xs font-medium">
                {columnTasks.length}
              </span>
            </div>

            <div className="flex flex-col gap-3">
              {columnTasks.map(task => (
                <ProjectTaskCard key={task.id} task={task} />
              ))}
            </div>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
