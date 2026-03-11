import { motion } from "framer-motion";

import type { MockTask, TaskStatus } from "@/lib/mock/project.mock";

import { ProjectTaskRow } from "./ProjectTaskRow";

type ProjectListViewProps = {
  readonly tasks: ReadonlyArray<MockTask>;
};

const GROUPS: Array<{ id: TaskStatus; label: string }> = [
  { id: "todo", label: "To Do" },
  { id: "in_progress", label: "In Progress" },
  { id: "done", label: "Done" },
];

export function ProjectListView({ tasks }: ProjectListViewProps) {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
      },
    },
  };

  const groupVariants = {
    hidden: { opacity: 0, y: 10 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
  };

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="flex w-full flex-col gap-10 pt-6 pb-16"
    >
      {GROUPS.map(group => {
        const groupTasks = tasks.filter(t => t.status === group.id);

        if (groupTasks.length === 0) {
          return null;
        }

        return (
          <motion.div key={group.id} variants={groupVariants}>
            <div className="mb-3 flex items-center gap-3 px-2">
              <h3 className="text-text-secondary text-[11px] font-medium tracking-wider uppercase">
                {group.label}
              </h3>
              <span className="text-text-tertiary flex h-5 w-5 items-center justify-center rounded-full bg-white/5 text-[10px] font-medium">
                {groupTasks.length}
              </span>
            </div>

            <div className="bg-canvas-elevated/40 flex flex-col overflow-hidden rounded-2xl border border-white/6">
              {groupTasks.map(task => (
                <ProjectTaskRow key={task.id} task={task} />
              ))}
            </div>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
