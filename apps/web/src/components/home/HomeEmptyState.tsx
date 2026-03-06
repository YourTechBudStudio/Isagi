import { motion } from "framer-motion";
import type { ReactNode } from "react";

import { getHomeRevealTransition } from "@/components/home/homeMotion";

type HomeEmptyStateProps = {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly actions: ReactNode;
};

export function HomeEmptyState({
  icon,
  title,
  description,
  actions,
}: HomeEmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={getHomeRevealTransition()}
      className="flex flex-1 flex-col items-center justify-center text-center"
    >
      <div className="bg-canvas-elevated mb-6 rounded-full border border-white/5 p-5 shadow-sm">
        {icon}
      </div>
      <h2 className="font-display text-text-primary mb-3 text-3xl font-medium tracking-tight">
        {title}
      </h2>
      <p className="text-text-secondary mb-8 max-w-sm text-lg font-light">
        {description}
      </p>
      {actions}
    </motion.div>
  );
}
