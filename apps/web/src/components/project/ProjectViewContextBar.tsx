import { AnimatePresence, motion } from "framer-motion";
import { Check, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

type PriorityFilter = "all" | "high" | "medium" | "low";
type SortKey = "due_date" | "priority";

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
}: ProjectViewContextBarProps) {
  const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (
        rootRef.current instanceof HTMLElement &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setIsDisplayMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const hasActiveFilters =
    priorityFilter !== "all" || collectionFilter !== "all";

  return (
    <div className="flex w-full items-center justify-between">
      <span className="text-text-tertiary text-xs font-medium">
        {resultCount} of {totalCount} tasks
      </span>

      <div ref={rootRef} className="flex items-center gap-3">
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
            onChange={e => onSearchChange(e.target.value)}
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

        <div className="relative">
          <button
            type="button"
            onClick={() => setIsDisplayMenuOpen(prev => !prev)}
            className={cn(
              "flex h-8 cursor-pointer items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-all duration-300",
              isDisplayMenuOpen || hasActiveFilters
                ? "border-accent-blue/30 bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20"
                : "text-text-secondary hover:text-text-primary border-transparent bg-white/[0.04] hover:bg-white/[0.08]",
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Display
            {hasActiveFilters && (
              <span className="bg-accent-blue absolute top-1 right-1 flex h-2 w-2 items-center justify-center rounded-full" />
            )}
          </button>

          <AnimatePresence>
            {isDisplayMenuOpen && (
              <motion.div
                initial={{ opacity: 0, y: 4, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.96 }}
                transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                className="bg-canvas-elevated absolute top-full right-0 z-30 mt-2 w-64 rounded-2xl border border-white/10 p-2 shadow-2xl backdrop-blur-xl"
              >
                <div className="flex flex-col gap-1">
                  {/* Group By (Read-only for now) */}
                  <div className="px-2 pt-2 pb-1">
                    <h4 className="text-text-tertiary text-[11px] font-semibold tracking-wider uppercase">
                      Group By
                    </h4>
                  </div>
                  <div className="text-text-secondary flex items-center justify-between rounded-lg px-2 py-1.5 text-[13px]">
                    <span>Status</span>
                    <Check className="text-text-tertiary h-4 w-4" />
                  </div>

                  <div className="mx-2 my-1 h-px bg-white/5" />

                  {/* Sort By */}
                  <div className="px-2 pt-2 pb-1">
                    <h4 className="text-text-tertiary text-[11px] font-semibold tracking-wider uppercase">
                      Sort By
                    </h4>
                  </div>
                  {[
                    { value: "due_date" as const, label: "Due Date" },
                    { value: "priority" as const, label: "Priority" },
                  ].map(option => (
                    <button
                      key={option.value}
                      onClick={() => onSortChange(option.value)}
                      className="text-text-secondary hover:text-text-primary flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors hover:bg-white/5"
                    >
                      <span>{option.label}</span>
                      {sortKey === option.value && (
                        <Check className="text-accent-blue h-4 w-4" />
                      )}
                    </button>
                  ))}

                  <div className="mx-2 my-1 h-px bg-white/5" />

                  {/* Filter: Priority */}
                  <div className="px-2 pt-2 pb-1">
                    <h4 className="text-text-tertiary text-[11px] font-semibold tracking-wider uppercase">
                      Filter: Priority
                    </h4>
                  </div>
                  {[
                    { value: "all" as const, label: "All" },
                    { value: "high" as const, label: "High" },
                    { value: "medium" as const, label: "Medium" },
                    { value: "low" as const, label: "Low" },
                  ].map(option => (
                    <button
                      key={option.value}
                      onClick={() => onPriorityChange(option.value)}
                      className="text-text-secondary hover:text-text-primary flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors hover:bg-white/5"
                    >
                      <span>{option.label}</span>
                      {priorityFilter === option.value && (
                        <Check className="text-accent-blue h-4 w-4" />
                      )}
                    </button>
                  ))}

                  <div className="mx-2 my-1 h-px bg-white/5" />

                  {/* Filter: Collection */}
                  <div className="px-2 pt-2 pb-1">
                    <h4 className="text-text-tertiary text-[11px] font-semibold tracking-wider uppercase">
                      Filter: Collection
                    </h4>
                  </div>
                  <button
                    onClick={() => onCollectionChange("all")}
                    className="text-text-secondary hover:text-text-primary flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors hover:bg-white/5"
                  >
                    <span>All Collections</span>
                    {collectionFilter === "all" && (
                      <Check className="text-accent-blue h-4 w-4" />
                    )}
                  </button>
                  {collectionOptions.map(option => (
                    <button
                      key={option}
                      onClick={() => onCollectionChange(option)}
                      className="text-text-secondary hover:text-text-primary flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors hover:bg-white/5"
                    >
                      <span className="truncate pr-4">{option}</span>
                      {collectionFilter === option && (
                        <Check className="text-accent-blue h-4 w-4 shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
