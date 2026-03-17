import { motion } from "framer-motion";
import { Play, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/Button";

type ProjectEmptyStateProps = {
  readonly projectId: string;
};

export function ProjectEmptyState({ projectId }: ProjectEmptyStateProps) {
  const navigate = useNavigate();

  const handleShapeWhatsNext = () => {
    navigate(`/session/${projectId}-shaping`);
  };

  const handleStartAdHocSession = () => {
    navigate(`/session/${projectId}-scratch-${Date.now()}`);
  };

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="flex max-w-sm flex-col items-center gap-6"
      >
        <div className="bg-canvas-subtle flex h-20 w-20 items-center justify-center rounded-3xl border border-white/5 shadow-sm">
          <Sparkles className="text-text-tertiary h-8 w-8" />
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="font-display text-text-primary text-2xl font-semibold tracking-tight">
            No actionable work yet
          </h2>
          <p className="text-text-secondary font-body">
            Suspicious. I&apos;ll allow it for now. Want me to shape the mess
            into something executable, or should we skip straight to tracked
            work?
          </p>
        </div>

        <div className="mt-4 flex w-full flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              size="lg"
              leadingIcon={<Sparkles className="h-4 w-4" />}
              className="w-full justify-center"
              onClick={handleShapeWhatsNext}
            >
              Shape what&apos;s next
            </Button>
            <p className="text-text-tertiary px-2 text-sm leading-relaxed">
              Launch the Shaper to turn chaos into a backlog. I&apos;ll help
              figure out what matters and what&apos;s noise.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Button
              variant="secondary"
              size="lg"
              leadingIcon={<Play className="h-4 w-4" />}
              className="w-full justify-center"
              onClick={handleStartAdHocSession}
            >
              Start ad-hoc session
            </Button>
            <p className="text-text-tertiary px-2 text-sm leading-relaxed">
              Jump into tracked work now. The first prompt creates the task
              &mdash; no ceremony required.
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
