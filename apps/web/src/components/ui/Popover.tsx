import { AnimatePresence, motion } from "framer-motion";
import { type ReactNode, useEffect, useRef, useState } from "react";
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

export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  align = "start",
  minWidth,
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<React.CSSProperties>({});

  // Compute position when opening
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const base: React.CSSProperties = {
      position: "fixed",
      top: rect.bottom + 6,
      minWidth: minWidth ?? rect.width,
    };

    if (align === "start") {
      base.left = rect.left;
    } else if (align === "center") {
      base.left = rect.left + rect.width / 2;
      base.transform = "translateX(-50%)";
    } else {
      base.right = window.innerWidth - rect.right;
    }

    setPosition(base);
  }, [open, anchorRef, align, minWidth]);

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
          style={position}
          className="bg-canvas-elevated z-[100] overflow-hidden rounded-xl border border-white/10 shadow-2xl"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
