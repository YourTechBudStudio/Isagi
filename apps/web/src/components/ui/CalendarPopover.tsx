import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

type CalendarPopoverProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly anchorRef: React.RefObject<HTMLElement | null>;
  readonly value?: string; // "YYYY-MM-DD" or undefined
  readonly onChange: (date: string | undefined) => void;
};

const DAYS_OF_WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Returns 0=Mon … 6=Sun for the first day of the month */
function getFirstDayOfWeek(year: number, month: number): number {
  const day = new Date(year, month, 1).getDay();
  return day === 0 ? 6 : day - 1; // shift from Sun=0 to Mon=0
}

function formatMonth(year: number, month: number): string {
  return new Date(year, month).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function toDateString(year: number, month: number, day: number): string {
  const m = String(month + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

function parseDate(value?: string): { year: number; month: number } {
  if (value) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return { year: d.getFullYear(), month: d.getMonth() };
    }
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

const HIDDEN_POPOVER_STYLE: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  visibility: "hidden",
  pointerEvents: "none",
};

type CalendarPopoverContentProps = {
  readonly popoverRef: React.RefObject<HTMLDivElement | null>;
  readonly value?: string;
  readonly onChange: (date: string | undefined) => void;
  readonly onClose: () => void;
};

function CalendarPopoverContent({
  popoverRef,
  value,
  onChange,
  onClose,
}: CalendarPopoverContentProps) {
  const initial = parseDate(value);
  const [viewYear, setViewYear] = useState(initial.year);
  const [viewMonth, setViewMonth] = useState(initial.month);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const handleDayClick = (day: number) => {
    onChange(toDateString(viewYear, viewMonth, day));
    onClose();
  };

  const handleClear = () => {
    onChange(undefined);
    onClose();
  };

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth);

  const todayStr = toDateString(
    new Date().getFullYear(),
    new Date().getMonth(),
    new Date().getDate(),
  );

  return (
    <motion.div
      ref={popoverRef}
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -4 }}
      transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
      style={HIDDEN_POPOVER_STYLE}
      className="bg-canvas-elevated z-[100] w-[280px] overflow-hidden rounded-xl border border-white/10 p-3 shadow-2xl"
    >
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={prevMonth}
          className="text-text-secondary hover:text-text-primary rounded-lg p-1 transition-colors hover:bg-white/5"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="font-display text-text-primary text-sm font-medium">
          {formatMonth(viewYear, viewMonth)}
        </span>
        <button
          type="button"
          onClick={nextMonth}
          className="text-text-secondary hover:text-text-primary rounded-lg p-1 transition-colors hover:bg-white/5"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-1 grid grid-cols-7 gap-0.5">
        {DAYS_OF_WEEK.map(d => (
          <div
            key={d}
            className="text-text-tertiary flex h-8 items-center justify-center text-[11px] font-medium"
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {Array.from({ length: firstDay }).map((_, i) => (
          <div key={`empty-${i}`} className="h-8" />
        ))}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const dateStr = toDateString(viewYear, viewMonth, day);
          const isSelected = dateStr === value;
          const isToday = dateStr === todayStr;

          return (
            <button
              key={day}
              type="button"
              onClick={() => handleDayClick(day)}
              className={cn(
                "flex h-8 w-full items-center justify-center rounded-lg text-sm transition-colors",
                isSelected
                  ? "bg-accent-blue text-canvas font-semibold"
                  : isToday
                    ? "text-accent-blue font-medium hover:bg-white/5"
                    : "text-text-secondary hover:text-text-primary hover:bg-white/5",
              )}
            >
              {day}
            </button>
          );
        })}
      </div>

      {value && (
        <button
          type="button"
          onClick={handleClear}
          className="text-text-tertiary hover:text-text-secondary mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs transition-colors hover:bg-white/5"
        >
          <X className="h-3 w-3" />
          Clear date
        </button>
      )}
    </motion.div>
  );
}

export function CalendarPopover({
  open,
  onClose,
  anchorRef,
  value,
  onChange,
}: CalendarPopoverProps) {
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
    popoverElement.style.left = `${rect.left}px`;
    popoverElement.style.visibility = "visible";
    popoverElement.style.pointerEvents = "auto";
  }, [open, anchorRef]);

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
        <CalendarPopoverContent
          popoverRef={popoverRef}
          value={value}
          onChange={onChange}
          onClose={onClose}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}
