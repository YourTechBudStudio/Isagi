import { motion } from "framer-motion";
import { Coffee } from "lucide-react";

import { cn } from "@/lib/cn";

type SparksEmptyStateProps = {
  readonly className?: string;
};

export function SparksEmptyState({ className }: SparksEmptyStateProps) {
  return (
    <div
      className={cn(
        "relative flex w-full flex-col items-center justify-center py-32 text-center",
        className,
      )}
    >
      <div className="relative mb-12 flex h-32 w-32 items-center justify-center">
        {/* Soft, breathing orb backdrops */}
        <motion.div
          className="bg-accent-green/20 absolute inset-0 rounded-full blur-2xl"
          animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="bg-accent-blue/20 absolute inset-0 rounded-full blur-2xl"
          animate={{ scale: [1.2, 1, 1.2], opacity: [0.6, 0.3, 0.6] }}
          transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
        />

        {/* Crisp foreground icon container */}
        <div className="bg-canvas-subtle/80 relative z-10 flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg ring-1 ring-white/10 backdrop-blur-md">
          <Coffee className="text-text-secondary h-8 w-8" />
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.2 }}
        className="flex flex-col items-center gap-3"
      >
        <h2 className="font-display text-text-secondary text-2xl font-semibold tracking-tight">
          Nothing to unblock. Suspicious.
        </h2>
        <p className="text-text-tertiary text-lg font-light">
          I'll allow it. Go take a break.
        </p>
      </motion.div>
    </div>
  );
}
