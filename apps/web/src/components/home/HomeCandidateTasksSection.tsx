import { motion } from "framer-motion";
import { CheckCircle2, TerminalSquare } from "lucide-react";

import { FocusQueueItem } from "@/components/home/FocusQueueItem";
import { getHomeRevealTransition } from "@/components/home/homeMotion";
import { Button } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/SectionHeading";
import type { HomeCandidateTask } from "@/lib/mock/home.mock";

type HomeCandidateTasksSectionProps = {
  readonly tasks: ReadonlyArray<HomeCandidateTask>;
};

export function HomeCandidateTasksSection({
  tasks,
}: HomeCandidateTasksSectionProps) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={getHomeRevealTransition(0.1)}
      className="mb-12"
    >
      <SectionHeading
        icon={<CheckCircle2 className="text-accent-green h-5 w-5 opacity-80" />}
        title="Candidate Tasks"
      />

      <div className="space-y-3">
        {tasks.map(task => (
          <FocusQueueItem
            key={task.id}
            title={task.title}
            project={task.project}
            action={
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<TerminalSquare className="h-3.5 w-3.5" />}
                className="scale-95 opacity-0 group-hover:scale-100 group-hover:opacity-100"
              >
                Start Session
              </Button>
            }
          />
        ))}
      </div>
    </motion.section>
  );
}
