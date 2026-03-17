import {
  Copy,
  LayoutDashboard,
  ListTodo,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";
import type { ProjectSavedView } from "@/lib/project-detail-storage";

type ProjectViewManageMenuProps = {
  readonly selectedView: ProjectSavedView;
  readonly viewsCount: number;
  readonly onRenameView: (viewId: string, name: string) => void;
  readonly onDuplicateView: (viewId: string) => void;
  readonly onDeleteView: (viewId: string) => void;
};

export function ProjectViewManageMenu({
  selectedView,
  viewsCount,
  onRenameView,
  onDuplicateView,
  onDeleteView,
}: ProjectViewManageMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const frameId = requestAnimationFrame(() =>
      renameInputRef.current?.focus(),
    );
    return () => cancelAnimationFrame(frameId);
  }, [isOpen]);

  const handleRenameView = () => {
    onRenameView(selectedView.id, renameDraft.trim());
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setRenameDraft(selectedView.name);
          setIsOpen(prev => !prev);
        }}
        className={cn(
          "flex h-8 items-center justify-center rounded-full border px-2.5 transition-all duration-300 ease-out",
          isOpen
            ? "border-accent-blue/30 bg-accent-blue/10 text-accent-blue shadow-[0_2px_8px_rgba(138,173,244,0.15)]"
            : "text-text-secondary hover:text-text-primary border-transparent bg-white/4 hover:bg-white/8",
        )}
        aria-label="Manage selected view"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      <Popover
        open={isOpen}
        onClose={() => setIsOpen(false)}
        anchorRef={triggerRef}
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
                setIsOpen(false);
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
                setIsOpen(false);
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
        </div>
      </Popover>
    </div>
  );
}
