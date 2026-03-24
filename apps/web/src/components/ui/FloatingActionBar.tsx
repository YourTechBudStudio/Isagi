import { motion, type Transition } from "framer-motion";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

type FloatingActionBarProps = {
  readonly children: ReactNode;
  readonly hidden: boolean;
  readonly rightInset: number;
  readonly rightTransition: Transition;
  readonly className?: string;
};

export function FloatingActionBar({
  children,
  hidden,
  rightInset,
  rightTransition,
  className,
}: FloatingActionBarProps) {
  return (
    <motion.header
      initial={false}
      animate={{
        y: hidden ? "-150%" : 0,
        right: rightInset,
      }}
      transition={{
        y: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
        right: rightTransition,
      }}
      className={cn(
        "pointer-events-none fixed top-6 z-30 flex items-center justify-between",
        className,
      )}
    >
      {children}
    </motion.header>
  );
}
