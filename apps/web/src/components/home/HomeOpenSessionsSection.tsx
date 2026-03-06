import { motion } from "framer-motion";
import { Play, TerminalSquare } from "lucide-react";

import { FocusQueueItem } from "@/components/home/FocusQueueItem";
import { getHomeRevealTransition } from "@/components/home/homeMotion";
import { Button } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/SectionHeading";
import type { HomeOpenSession } from "@/lib/mock/home.mock";

type HomeOpenSessionsSectionProps = {
  readonly sessions: ReadonlyArray<HomeOpenSession>;
};

export function HomeOpenSessionsSection({
  sessions,
}: HomeOpenSessionsSectionProps) {
  if (sessions.length === 0) {
    return null;
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={getHomeRevealTransition(0.2)}
      className="mb-14"
    >
      <SectionHeading
        icon={
          <TerminalSquare className="text-text-tertiary h-5 w-5 opacity-80" />
        }
        title="Other Open Sessions"
      />

      <div className="space-y-3">
        {sessions.map(session => (
          <FocusQueueItem
            key={session.id}
            title={session.title}
            project={session.project}
            action={
              session.actionLabel ? (
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Play className="h-3.5 w-3.5" />}
                  className="scale-95 opacity-0 group-hover:scale-100 group-hover:opacity-100"
                >
                  {session.actionLabel}
                </Button>
              ) : null
            }
          />
        ))}
      </div>
    </motion.section>
  );
}
