import {
  Check,
  Copy,
  LayoutDashboard,
  ListTodo,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import type {
  ProjectSavedView,
  ProjectViewLayout,
} from "@/lib/project-detail-storage";

type ProjectSavedViewTabsProps = {
  readonly views: ReadonlyArray<ProjectSavedView>;
  readonly selectedViewId: string;
  readonly onSelectView: (viewId: string) => void;
  readonly onCreateView: (input: {
    readonly name: string;
    readonly layout: ProjectViewLayout;
  }) => void;
  readonly onRenameView: (viewId: string, name: string) => void;
  readonly onDuplicateView: (viewId: string) => void;
  readonly onDeleteView: (viewId: string) => void;
};

function getLayoutIcon(layout: ProjectViewLayout) {
  return layout === "board" ? LayoutDashboard : ListTodo;
}

export function ProjectSavedViewTabs({
  views,
  selectedViewId,
  onSelectView,
  onCreateView,
  onRenameView,
  onDuplicateView,
  onDeleteView,
}: ProjectSavedViewTabsProps) {
  const selectedView =
    views.find(view => view.id === selectedViewId) ?? views[0] ?? null;
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [isManageMenuOpen, setIsManageMenuOpen] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [newViewLayout, setNewViewLayout] =
    useState<ProjectViewLayout>("board");
  const [renameDraft, setRenameDraft] = useState("");
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const manageButtonRef = useRef<HTMLButtonElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isCreateMenuOpen) {
      return;
    }

    const frameId = requestAnimationFrame(() =>
      createInputRef.current?.focus(),
    );
    return () => cancelAnimationFrame(frameId);
  }, [isCreateMenuOpen]);

  useEffect(() => {
    if (!isManageMenuOpen) {
      return;
    }

    const frameId = requestAnimationFrame(() =>
      renameInputRef.current?.focus(),
    );
    return () => cancelAnimationFrame(frameId);
  }, [isManageMenuOpen]);

  const handleCreateView = () => {
    onCreateView({
      name: newViewName.trim(),
      layout: newViewLayout,
    });
    setNewViewName("");
    setNewViewLayout("board");
    setIsCreateMenuOpen(false);
  };

  const handleRenameView = () => {
    if (!selectedView) {
      return;
    }

    onRenameView(selectedView.id, renameDraft.trim());
    setIsManageMenuOpen(false);
  };

  return (
    <div className="flex items-center gap-2">
      <div className="bg-canvas-subtle/60 flex items-center gap-1 rounded-2xl border border-white/6 p-1">
        {views.map(view => {
          const Icon = getLayoutIcon(view.layout);

          return (
            <button
              key={view.id}
              type="button"
              onClick={() => onSelectView(view.id)}
              className={cn(
                "flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium transition-all duration-300",
                view.id === selectedViewId
                  ? "text-text-primary bg-white/10 shadow-sm"
                  : "text-text-secondary hover:text-text-primary hover:bg-white/5",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="max-w-40 truncate">{view.name}</span>
            </button>
          );
        })}
      </div>

      <button
        ref={createButtonRef}
        type="button"
        onClick={() => {
          if (!isCreateMenuOpen && selectedView) {
            setNewViewLayout(selectedView.layout);
          }

          setIsCreateMenuOpen(prev => !prev);
          setIsManageMenuOpen(false);
        }}
        className={cn(
          "text-text-secondary hover:text-text-primary flex h-9 items-center gap-2 rounded-xl border border-dashed px-3 text-sm font-medium transition-all duration-300",
          isCreateMenuOpen
            ? "border-accent-blue/30 bg-accent-blue/10 text-accent-blue"
            : "border-white/10 bg-white/3 hover:border-white/20 hover:bg-white/5",
        )}
      >
        <Plus className="h-4 w-4" />
        New view
      </button>

      <button
        ref={manageButtonRef}
        type="button"
        onClick={() => {
          if (!selectedView) {
            return;
          }

          setRenameDraft(selectedView.name);
          setIsManageMenuOpen(prev => !prev);
          setIsCreateMenuOpen(false);
        }}
        className={cn(
          "text-text-secondary hover:text-text-primary flex h-9 items-center gap-2 rounded-xl border px-3 text-sm font-medium transition-all duration-300",
          isManageMenuOpen
            ? "border-accent-blue/30 bg-accent-blue/10 text-accent-blue"
            : "border-white/10 bg-white/3 hover:border-white/20 hover:bg-white/5",
        )}
        aria-label="Manage selected view"
        disabled={!selectedView}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      <Popover
        open={isCreateMenuOpen}
        onClose={() => setIsCreateMenuOpen(false)}
        anchorRef={createButtonRef}
        align="start"
        minWidth={300}
      >
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-1">
            <h3 className="text-text-primary font-display text-sm font-semibold">
              Create saved view
            </h3>
            <p className="text-text-tertiary text-xs leading-relaxed">
              Clone the current setup, then choose how you want to look at the
              backlog.
            </p>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
              View name
            </span>
            <input
              ref={createInputRef}
              type="text"
              value={newViewName}
              onChange={event => setNewViewName(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleCreateView();
                }
              }}
              placeholder="Sprint focus"
              className="text-text-primary placeholder:text-text-tertiary/50 bg-canvas focus:border-accent-blue/40 rounded-xl border border-white/10 px-3 py-2.5 text-sm transition-colors outline-none"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
              Layout
            </span>
            <div className="bg-canvas-subtle/60 flex items-center gap-1 rounded-xl border border-white/6 p-1">
              {(
                [
                  { value: "board", label: "Board" },
                  { value: "list", label: "List" },
                ] as const
              ).map(option => {
                const Icon = getLayoutIcon(option.value);

                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setNewViewLayout(option.value)}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      option.value === newViewLayout
                        ? "text-text-primary bg-white/10"
                        : "text-text-secondary hover:text-text-primary hover:bg-white/5",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {option.label}
                    {option.value === newViewLayout ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsCreateMenuOpen(false)}
              className="text-text-tertiary hover:text-text-primary rounded-lg px-2 py-1.5 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreateView}
              className="bg-accent-blue text-canvas hover:bg-accent-blue/90 rounded-xl px-3.5 py-2 text-sm font-semibold shadow-sm transition-colors"
            >
              Create view
            </button>
          </div>
        </div>
      </Popover>

      <Popover
        open={isManageMenuOpen}
        onClose={() => setIsManageMenuOpen(false)}
        anchorRef={manageButtonRef}
        align="start"
        minWidth={320}
      >
        <div className="flex flex-col gap-4 p-4">
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
              <div className="bg-canvas-subtle/60 flex items-center justify-between rounded-xl border border-white/6 px-3 py-2.5">
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
                    className="text-text-primary bg-canvas focus:border-accent-blue/40 min-w-0 flex-1 rounded-xl border border-white/10 px-3 py-2.5 text-sm transition-colors outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleRenameView}
                    className="text-text-primary rounded-xl border border-white/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-white/10"
                  >
                    Save
                  </button>
                </div>
              </label>

              <div className="flex flex-col gap-2 rounded-xl border border-white/6 p-1.5">
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
                  disabled={views.length <= 1}
                  className="text-accent-red disabled:text-text-tertiary/40 hover:bg-accent-red/10 flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors disabled:hover:bg-transparent"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete view
                </button>
              </div>

              <p className="text-text-tertiary text-xs leading-relaxed">
                {views.length <= 1
                  ? "At least one saved view has to survive. Even chaos needs a tab."
                  : "Deleting the selected view removes only this lens, not the tasks inside it."}
              </p>
            </>
          ) : null}
        </div>
      </Popover>
    </div>
  );
}
