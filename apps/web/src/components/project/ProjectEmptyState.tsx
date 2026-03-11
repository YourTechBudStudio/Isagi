import { motion } from "framer-motion";
import { Plus, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/Button";

export function ProjectEmptyState() {
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
            Suspicious. I'll allow it for now. Ready to start plotting your next
            moves?
          </p>
        </div>

        <div className="mt-4 flex w-full flex-col items-center gap-3">
          <Button
            variant="primary"
            size="lg"
            leadingIcon={<Plus className="h-4 w-4" />}
            className="w-full justify-center"
          >
            New Task
          </Button>
          <Button
            variant="secondary"
            size="lg"
            leadingIcon={<Sparkles className="text-accent-violet h-4 w-4" />}
            className="w-full justify-center"
          >
            Plan with PM agent
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
