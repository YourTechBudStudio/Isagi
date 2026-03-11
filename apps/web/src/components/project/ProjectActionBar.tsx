import { motion, useMotionValueEvent, useScroll } from "framer-motion";
import { FolderPlus, Plus, Sparkles } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";

export function ProjectActionBar() {
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);

  useMotionValueEvent(scrollY, "change", latest => {
    const previous = scrollY.getPrevious() ?? 0;
    if (latest > previous && latest > 50) {
      setHidden(true);
    } else {
      setHidden(false);
    }
  });

  return (
    <motion.header
      variants={{
        visible: { y: 0 },
        hidden: { y: "-150%" },
      }}
      animate={hidden ? "hidden" : "visible"}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-none fixed top-6 right-6 z-30 flex items-center justify-between"
    >
      <div className="bg-canvas-elevated/80 pointer-events-auto flex items-center gap-2 rounded-2xl border border-white/10 p-1.5 shadow-lg backdrop-blur-md">
        <div className="flex items-center gap-1 border-r border-white/10 px-1 pr-2">
          <Button
            variant="secondary"
            size="md"
            leadingIcon={<FolderPlus className="h-4 w-4" />}
            className="text-text-secondary hover:text-text-primary border-none bg-transparent hover:bg-white/5"
          >
            New Collection
          </Button>
          <Button
            variant="secondary"
            size="md"
            leadingIcon={<Plus className="h-4 w-4" />}
            className="text-text-secondary hover:text-text-primary border-none bg-transparent hover:bg-white/5"
          >
            New Task
          </Button>
        </div>

        <Button
          variant="primary"
          size="md"
          leadingIcon={<Sparkles className="h-4 w-4" />}
          className="bg-accent-violet hover:bg-accent-violet/90 text-canvas ml-1"
        >
          Plan with PM agent
        </Button>
      </div>
    </motion.header>
  );
}
