import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  CircleDashed,
  Filter,
  ListFilter,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

type PriorityFilter = "all" | "high" | "medium" | "low";
type SortKey = "due_date" | "priority";
type OpenMenu = "priority" | "collection" | "sort" | null;

type ProjectViewContextBarProps = {
  readonly searchQuery: string;
  readonly onSearchChange: (value: string) => void;
  readonly priorityFilter: PriorityFilter;
  readonly onPriorityChange: (value: PriorityFilter) => void;
  readonly collectionFilter: string;
  readonly onCollectionChange: (value: string) => void;
  readonly sortKey: SortKey;
  readonly onSortChange: (value: SortKey) => void;
  readonly collectionOptions: ReadonlyArray<string>;
  readonly resultCount: number;
  readonly totalCount: number;
  readonly onReset: () => void;
};

type ContextSelectProps = {
  readonly label: string;
  readonly icon: ReactNode;
  readonly isActive?: boolean;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
};

function ContextSelect({
  label,
  icon,
  isActive = false,
  isOpen,
  onToggle,
  children,
}: ContextSelectProps) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex h-8 cursor-pointer items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-all duration-300",
          isActive
            ? "border-accent-blue/30 bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20"
            : "text-text-secondary hover:text-text-primary border-transparent bg-white/[0.04] hover:bg-white/[0.08]",
        )}
      >
        <span
          className={cn(
            "flex items-center justify-center opacity-70",
            isActive ? "text-accent-blue" : "text-text-tertiary",
          )}
        >
          {icon}
        </span>
        <span>{label}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 opacity-50 transition-transform duration-300",
            isOpen && "rotate-180",
          )}
        />
      </button>

      <AnimatePresence>
        {isOpen ? (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.96 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="bg-canvas-elevated absolute top-full left-0 z-30 mt-1.5 min-w-[200px] rounded-2xl border border-white/10 p-1.5 shadow-xl"
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function ProjectViewContextBar({
  searchQuery,
  onSearchChange,
  priorityFilter,
  onPriorityChange,
  collectionFilter,
  onCollectionChange,
  sortKey,
  onSortChange,
  collectionOptions,
  resultCount,
  totalCount,
  onReset,
}: ProjectViewContextBarProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (
        rootRef.current instanceof HTMLElement &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setOpenMenu(null);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const hasActiveViewContext =
    searchQuery.trim().length > 0 ||
    priorityFilter !== "all" ||
    collectionFilter !== "all" ||
    sortKey !== "due_date";

  const priorityLabelByValue: Record<PriorityFilter, string> = {
    all: "Priority",
    high: "High priority",
    medium: "Medium priority",
    low: "Low priority",
  };

  const sortLabelByValue: Record<SortKey, string> = {
    due_date: "Due date",
    priority: "Priority",
  };

  const collectionLabel =
    collectionFilter === "all" ? "Collection" : collectionFilter;

  return (
    <div ref={rootRef} className="flex flex-wrap items-center gap-2">
      <label
        className={cn(
          "flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] transition-all duration-300",
          searchQuery.trim().length > 0
            ? "border-accent-blue/30 bg-accent-blue/5 focus-within:border-accent-blue/50 focus-within:bg-accent-blue/10"
            : "border-transparent bg-white/[0.04] focus-within:border-white/20 focus-within:bg-white/[0.06] hover:bg-white/[0.08]",
        )}
      >
        <Search
          className={cn(
            "h-3.5 w-3.5 transition-colors",
            searchQuery.trim().length > 0
              ? "text-accent-blue"
              : "text-text-tertiary",
          )}
        />
        <input
          type="search"
          value={searchQuery}
          onChange={event => onSearchChange(event.target.value)}
          placeholder="Search..."
          className="text-text-primary placeholder:text-text-tertiary w-24 min-w-0 flex-1 bg-transparent font-medium transition-all duration-300 outline-none focus:w-32"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            className="text-text-tertiary hover:text-text-primary cursor-pointer transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </label>

      <div className="mx-1 h-4 w-px bg-white/10" />

      <ContextSelect
        label={priorityLabelByValue[priorityFilter]}
        icon={<Filter className="h-3.5 w-3.5" />}
        isActive={priorityFilter !== "all"}
        isOpen={openMenu === "priority"}
        onToggle={() =>
          setOpenMenu(current => (current === "priority" ? null : "priority"))
        }
      >
        {(
          [
            ["all", "All priorities"],
            ["high", "High"],
            ["medium", "Medium"],
            ["low", "Low"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              onPriorityChange(value);
              setOpenMenu(null);
            }}
            className={cn(
              "w-full cursor-pointer rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors",
              priorityFilter === value
                ? "bg-accent-blue/10 text-accent-blue"
                : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]",
            )}
          >
            {label}
          </button>
        ))}
      </ContextSelect>

      <ContextSelect
        label={collectionLabel}
        icon={<CircleDashed className="h-3.5 w-3.5" />}
        isActive={collectionFilter !== "all"}
        isOpen={openMenu === "collection"}
        onToggle={() =>
          setOpenMenu(current =>
            current === "collection" ? null : "collection",
          )
        }
      >
        <button
          type="button"
          onClick={() => {
            onCollectionChange("all");
            setOpenMenu(null);
          }}
          className={cn(
            "w-full cursor-pointer rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors",
            collectionFilter === "all"
              ? "bg-accent-blue/10 text-accent-blue"
              : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]",
          )}
        >
          All collections
        </button>

        {collectionOptions.map(option => (
          <button
            key={option}
            type="button"
            onClick={() => {
              onCollectionChange(option);
              setOpenMenu(null);
            }}
            className={cn(
              "w-full cursor-pointer rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors",
              collectionFilter === option
                ? "bg-accent-blue/10 text-accent-blue"
                : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]",
            )}
          >
            {option}
          </button>
        ))}
      </ContextSelect>

      <ContextSelect
        label={sortLabelByValue[sortKey]}
        icon={<ListFilter className="h-3.5 w-3.5" />}
        isActive={sortKey !== "due_date"}
        isOpen={openMenu === "sort"}
        onToggle={() =>
          setOpenMenu(current => (current === "sort" ? null : "sort"))
        }
      >
        {(
          [
            ["due_date", "Due date"],
            ["priority", "Priority"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              onSortChange(value);
              setOpenMenu(null);
            }}
            className={cn(
              "w-full cursor-pointer rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors",
              sortKey === value
                ? "bg-accent-blue/10 text-accent-blue"
                : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]",
            )}
          >
            {label}
          </button>
        ))}
      </ContextSelect>

      {hasActiveViewContext && (
        <>
          <div className="mx-1 h-4 w-px bg-white/10" />
          <button
            type="button"
            onClick={onReset}
            className="text-text-secondary hover:text-text-primary flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors hover:bg-white/[0.04]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
        </>
      )}

      <div className="flex-1" />
      <span className="text-text-tertiary text-xs">
        {resultCount} of {totalCount} tasks
      </span>
    </div>
  );
}
