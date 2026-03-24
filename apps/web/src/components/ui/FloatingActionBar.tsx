import {
  motion,
  type Transition,
  useMotionValueEvent,
  useScroll,
} from "framer-motion";
import { type ReactNode, useState } from "react";

import { cn } from "@/lib/cn";

type FloatingActionBarProps = {
  readonly children: ReactNode;
  readonly rightInset: number;
  readonly rightTransition: Transition;
  readonly className?: string;
  readonly hideOnScroll?: boolean;
};

export function FloatingActionBar({
  children,
  rightInset,
  rightTransition,
  className,
  hideOnScroll = true,
}: FloatingActionBarProps) {
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);

  useMotionValueEvent(scrollY, "change", latest => {
    if (!hideOnScroll) {
      return;
    }

    const previous = scrollY.getPrevious() ?? 0;
    setHidden(latest > previous && latest > 50);
  });

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
