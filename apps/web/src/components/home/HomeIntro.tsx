import { motion } from "framer-motion";

import { getHomeRevealTransition } from "@/components/home/homeMotion";

type HomeIntroProps = {
  readonly title: string;
  readonly description: string;
};

export function HomeIntro({ title, description }: HomeIntroProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={getHomeRevealTransition()}
      className="mb-14"
    >
      <h1 className="font-display text-text-primary mb-3 text-5xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="text-text-secondary text-lg font-light">{description}</p>
    </motion.div>
  );
}
