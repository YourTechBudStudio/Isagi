import {
  Check,
  Copy,
  LayoutDashboard,
  ListTodo,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import type { ProjectSavedView } from "@/lib/project-detail-storage";

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
  readonly selectedView: ProjectSavedView;
  readonly viewsCount: number;
  readonly onRenameView: (viewId: string, name: string) => void;
  readonly onDuplicateView: (viewId: string) => void;
  readonly onDeleteView: (viewId: string) => void;
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
  selectedView,
  viewsCount,
  onRenameView,
  onDuplicateView,
  onDeleteView,
}: ProjectViewContextBarProps) {
  const [isDisplayMenuOpen, setIsDisplayMenuOpen] = useState(false);
  const [isManageMenuOpen, setIsManageMenuOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");

  const displayRef = useRef<HTMLButtonElement>(null);
  const manageRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const hasActiveFilters =
    priorityFilter !== "all" || collectionFilter !== "all";

  useEffect(() => {
    if (!isManageMenuOpen) {
      return;
    }

    const frameId = requestAnimationFrame(() =>
      renameInputRef.current?.focus(),
    );
    return () => cancelAnimationFrame(frameId);
  }, [isManageMenuOpen]);

  const handleRenameView = () => {
    if (!selectedView) {
      return;
    }

    onRenameView(selectedView.id, renameDraft.trim());
    setIsManageMenuOpen(false);
  };

  return (
    <div className="flex items-center gap-4">
      <span className="text-text-tertiary text-[13px] font-medium">
        {resultCount} of {totalCount} tasks
      </span>

      <div className="flex items-center gap-3">
        <label
          className={cn(
            "flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] transition-all duration-300 ease-out",
            searchQuery.trim().length > 0
              ? "border-accent-blue/30 bg-accent-blue/5 focus-within:border-accent-blue/50 focus-within:bg-accent-blue/10"
              : "border-transparent bg-white/4 focus-within:border-white/20 focus-within:bg-white/6 hover:bg-white/8",
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

        <div className="flex items-center gap-1.5 border-l border-white/10 pl-3">
          <div className="relative">
            <button
              ref={displayRef}
              type="button"
              onClick={() => {
                setIsDisplayMenuOpen(prev => !prev);
                setIsManageMenuOpen(false);
              }}
              className={cn(
                "flex h-8 cursor-pointer items-center gap-2 rounded-full border px-3 text-[13px] font-medium transition-all duration-300 ease-out",
                isDisplayMenuOpen || hasActiveFilters
                  ? "border-accent-blue/30 bg-accent-blue/10 text-accent-blue hover:bg-accent-blue/20 shadow-[0_2px_8px_rgba(138,173,244,0.15)]"
                  : "text-text-secondary hover:text-text-primary border-transparent bg-white/4 hover:bg-white/8",
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Display
              {hasActiveFilters && (
                <span className="bg-accent-blue absolute top-1 right-1 flex h-2 w-2 items-center justify-center rounded-full" />
              )}
            </button>

            <Popover
              open={isDisplayMenuOpen}
              onClose={() => setIsDisplayMenuOpen(false)}
              anchorRef={displayRef}
              align="end"
              minWidth={256}
            >
              <div className="bg-canvas-elevated/90 flex flex-col gap-1 p-2 backdrop-blur-xl">
                {/* Group By (Read-only for now) */}
                <div className="px-2 pt-2 pb-1">
                  <h4 className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
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
                  <h4 className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
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
                  <h4 className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
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
                  <h4 className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
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
            </Popover>
          </div>

          <div className="relative">
            <button
              ref={manageRef}
              type="button"
              onClick={() => {
                if (!selectedView) {
                  return;
                }

                setRenameDraft(selectedView.name);
                setIsManageMenuOpen(prev => !prev);
                setIsDisplayMenuOpen(false);
              }}
              className={cn(
                "flex h-8 items-center justify-center rounded-full border px-2.5 transition-all duration-300 ease-out",
                isManageMenuOpen
                  ? "border-accent-blue/30 bg-accent-blue/10 text-accent-blue shadow-[0_2px_8px_rgba(138,173,244,0.15)]"
                  : "text-text-secondary hover:text-text-primary border-transparent bg-white/4 hover:bg-white/8",
              )}
              aria-label="Manage selected view"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>

            <Popover
              open={isManageMenuOpen}
              onClose={() => setIsManageMenuOpen(false)}
              anchorRef={manageRef}
              align="end"
              minWidth={320}
            >
              <div className="bg-canvas-elevated/90 flex flex-col gap-4 p-4 backdrop-blur-xl">
                <div className="flex flex-col gap-1">
                  <h3 className="text-text-primary font-display text-sm font-semibold">
                    Manage view
                  </h3>
                  <p className="text-text-tertiary text-xs leading-relaxed">
                    Tune the selected view without leaving the workboard.
                  </p>
                </div>

                {selectedView ? (
                  <>
                    <div className="bg-canvas-subtle/60 flex items-center justify-between rounded-xl border border-white/6 px-3 py-2.5 shadow-inner inset-shadow-black/10">
                      <div className="text-text-primary flex items-center gap-2 text-sm font-medium">
                        {selectedView.layout === "board" ? (
                          <LayoutDashboard className="h-4 w-4" />
                        ) : (
                          <ListTodo className="h-4 w-4" />
                        )}
                        <span className="truncate">{selectedView.name}</span>
                      </div>
                      <span className="text-text-tertiary text-xs tracking-wider uppercase">
                        {selectedView.layout}
                      </span>
                    </div>

                    <label className="flex flex-col gap-1.5">
                      <span className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
                        Rename
                      </span>
                      <div className="flex items-center gap-2">
                        <input
                          ref={renameInputRef}
                          type="text"
                          value={renameDraft}
                          onChange={event => setRenameDraft(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              handleRenameView();
                            }
                          }}
                          className="text-text-primary bg-canvas/50 focus:bg-canvas focus:border-accent-blue/40 min-w-0 flex-1 rounded-xl border border-white/10 px-3 py-2.5 text-sm transition-all duration-300 outline-none"
                        />
                        <button
                          type="button"
                          onClick={handleRenameView}
                          className="text-text-primary rounded-xl border border-white/10 px-3 py-2.5 text-sm font-medium transition-colors hover:bg-white/10"
                        >
                          Save
                        </button>
                      </div>
                    </label>

                    <div className="bg-canvas-subtle/30 flex flex-col gap-1.5 rounded-xl border border-white/6 p-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          onDuplicateView(selectedView.id);
                          setIsManageMenuOpen(false);
                        }}
                        className="text-text-secondary hover:text-text-primary flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-white/5"
                      >
                        <Copy className="h-4 w-4" />
                        Duplicate view
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onDeleteView(selectedView.id);
                          setIsManageMenuOpen(false);
                        }}
                        disabled={viewsCount <= 1}
                        className="text-accent-red disabled:text-text-tertiary/40 hover:bg-accent-red/10 flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:hover:bg-transparent"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete view
                      </button>
                    </div>

                    <p className="text-text-tertiary text-xs leading-relaxed">
                      {viewsCount <= 1
                        ? "At least one saved view has to survive. Even chaos needs a tab."
                        : "Deleting the selected view removes only this lens, not the tasks inside it."}
                    </p>
                  </>
                ) : null}
              </div>
            </Popover>
          </div>
        </div>
      </div>
    </div>
  );
}
