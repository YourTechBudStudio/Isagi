import { useMotionValueEvent, useScroll } from "framer-motion";
import { useState } from "react";

export function useHideOnScrollHeader(threshold = 50): boolean {
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);

  useMotionValueEvent(scrollY, "change", latest => {
    const previous = scrollY.getPrevious() ?? 0;
    setHidden(latest > previous && latest > threshold);
  });

  return hidden;
}
