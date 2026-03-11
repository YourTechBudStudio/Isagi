import { AnimatePresence, motion } from "framer-motion";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

type PopoverProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly children: ReactNode;
  /** Horizontal alignment relative to the anchor. Default "start". */
  readonly align?: "start" | "center" | "end";
  /** Minimum width in pixels. Defaults to anchor width. */
  readonly minWidth?: number;
};

const HIDDEN_POPOVER_STYLE: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  visibility: "hidden",
  pointerEvents: "none",
};

export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  align = "start",
  minWidth,
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const popoverElement = popoverRef.current;
    const anchorElement = anchorRef.current;
    if (!popoverElement || !anchorElement) {
      return;
    }

    const rect = anchorElement.getBoundingClientRect();
    popoverElement.style.top = `${rect.bottom + 6}px`;
    popoverElement.style.minWidth = `${minWidth ?? rect.width}px`;
    popoverElement.style.left = "";
    popoverElement.style.right = "";
    popoverElement.style.translate = "";

    if (align === "start") {
      popoverElement.style.left = `${rect.left}px`;
    } else if (align === "center") {
      popoverElement.style.left = `${rect.left + rect.width / 2}px`;
      popoverElement.style.translate = "-50% 0";
    } else {
      popoverElement.style.right = `${window.innerWidth - rect.right}px`;
    }

    popoverElement.style.visibility = "visible";
    popoverElement.style.pointerEvents = "auto";
  }, [open, onClose, anchorRef, align, minWidth]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        anchorRef.current &&
        !anchorRef.current.contains(target)
      ) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };

    // Delay the listener slightly so the opening click doesn't immediately close it
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleEscape, true);
    });

    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [open, onClose, anchorRef]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={popoverRef}
          initial={{ opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: -4 }}
          transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
          style={HIDDEN_POPOVER_STYLE}
          className="bg-canvas-elevated z-[100] overflow-hidden rounded-xl border border-white/10 shadow-2xl"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
