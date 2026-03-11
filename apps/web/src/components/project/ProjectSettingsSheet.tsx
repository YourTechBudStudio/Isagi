import { AnimatePresence, motion } from "framer-motion";
import {
  GitBranch,
  GitFork,
  Globe,
  Layers,
  MessageSquareMore,
  Save,
  Settings2,
  TagIcon,
  Workflow,
  X as XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  PROJECT_SETTINGS_SHEET_WIDTH,
  projectSettingsSheetTransition,
} from "@/components/project/projectSettings.constants";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";

// ─── Types ───────────────────────────────────────────────────

type ProjectSettingsSheetProps = {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly projectName: string;
};

type GitMode =
  | "same_branch"
  | "managed_worktree"
  | "ask_each_time"
  | "global_default";

// ─── Mock Data ────────────────────────────────────────────────

const MOCK_STATUSES = [
  { id: "todo", label: "To Do", tone: "neutral" as const },
  { id: "in_progress", label: "In Progress", tone: "blue" as const },
  { id: "in_review", label: "In Review", tone: "amber" as const },
  { id: "done", label: "Done", tone: "green" as const },
];

const MOCK_TERMINOLOGY_ALIASES: ReadonlyArray<{
  term: string;
  alias: string;
}> = [
  { term: "collection", alias: "Epic" },
  { term: "task", alias: "Ticket" },
  { term: "session", alias: "Focus Block" },
];

const MOCK_COLLECTIONS = ["Frontend", "Backend", "DevOps", "Design"];

const MOCK_DEFAULT_LABELS = ["needs-review", "priority"];

const MOCK_SAVED_VIEWS = [
  { id: "v1", name: "My Active Tasks", isDefault: true },
  { id: "v2", name: "Needs Review", isDefault: false },
  { id: "v3", name: "High Priority Bugs", isDefault: false },
];

const GIT_MODE_OPTIONS: ReadonlyArray<{
  value: GitMode;
  label: string;
  description: string;
  icon: typeof GitBranch;
  activeColor: string;
}> = [
  {
    value: "same_branch",
    label: "Same branch",
    description: "Stay on the currently checked-out branch.",
    icon: GitBranch,
    activeColor: "text-accent-blue",
  },
  {
    value: "managed_worktree",
    label: "Managed worktree",
    description: "Auto-create an isolated worktree per session.",
    icon: GitFork,
    activeColor: "text-accent-green",
  },
  {
    value: "ask_each_time",
    label: "Ask each time",
    description: "Prompt for the git strategy at session start.",
    icon: MessageSquareMore,
    activeColor: "text-accent-amber",
  },
  {
    value: "global_default",
    label: "Use global default",
    description: "Inherit from your global Isagi configuration.",
    icon: Globe,
    activeColor: "text-accent-cyan",
  },
];

// ─── Component ───────────────────────────────────────────────

export function ProjectSettingsSheet({
  isOpen,
  onClose,
  projectName,
}: ProjectSettingsSheetProps) {
  // Local state for settings
  const [gitMode, setGitMode] = useState<GitMode>("global_default");
  const [labels, setLabels] = useState<string[]>([...MOCK_DEFAULT_LABELS]);
  const [labelInput, setLabelInput] = useState("");

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleAddLabel = () => {
    const trimmed = labelInput.trim().toLowerCase();
    if (trimmed && !labels.includes(trimmed)) {
      setLabels(prev => [...prev, trimmed]);
    }
    setLabelInput("");
  };

  const handleRemoveLabel = (label: string) => {
    setLabels(prev => prev.filter(l => l !== label));
  };

  const handleLabelKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddLabel();
    }
    if (e.key === "Backspace" && labelInput === "" && labels.length > 0) {
      setLabels(prev => prev.slice(0, -1));
    }
  };

  // ─── Render ────────────────────────────────────────────────

  return (
    <>
      {/* Layer 1: Push spacer — always mounted, animates width */}
      <motion.div
        animate={{ width: isOpen ? PROJECT_SETTINGS_SHEET_WIDTH : 0 }}
        transition={projectSettingsSheetTransition}
        className="shrink-0"
      />

      {/* Layer 2: Slide-in content panel — fixed positioned */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={projectSettingsSheetTransition}
            style={{ width: PROJECT_SETTINGS_SHEET_WIDTH }}
            className="bg-canvas-elevated/95 fixed inset-y-0 right-0 z-40 flex flex-col border-l border-white/10 shadow-2xl backdrop-blur-xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-5">
              <div className="flex items-center gap-3">
                <div className="bg-canvas-subtle flex h-8 w-8 items-center justify-center rounded-lg border border-white/5">
                  <Settings2 className="text-text-secondary h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-text-primary font-display text-lg font-semibold tracking-tight">
                    Project Settings
                  </h2>
                  <p className="text-text-tertiary text-xs">
                    Configuring{" "}
                    <span className="text-text-secondary font-medium">
                      {projectName}
                    </span>
                  </p>
                </div>
              </div>
              <IconButton
                icon={<XIcon className="h-5 w-5" />}
                onClick={onClose}
                aria-label="Close settings"
              />
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="flex flex-col gap-8">
                {/* ─── Section: Git Mode ─── */}
                <section className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <Workflow className="text-accent-blue h-4 w-4" />
                    <h3 className="text-text-primary font-display text-sm font-medium">
                      Default Git Mode
                    </h3>
                  </div>

                  <div className="bg-canvas-subtle/50 flex flex-col gap-1 rounded-xl border border-white/5 p-1">
                    {GIT_MODE_OPTIONS.map(opt => {
                      const isActive = gitMode === opt.value;
                      const Icon = opt.icon;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setGitMode(opt.value)}
                          className={cn(
                            "flex items-start gap-3 rounded-lg px-4 py-3 text-left transition-colors",
                            isActive
                              ? "bg-canvas border border-white/5 shadow-sm"
                              : "border border-transparent hover:bg-white/5",
                          )}
                        >
                          <Icon
                            className={cn(
                              "mt-0.5 h-4 w-4 shrink-0",
                              isActive ? opt.activeColor : "text-text-tertiary",
                            )}
                          />
                          <div className="flex flex-col gap-0.5">
                            <span
                              className={cn(
                                "text-sm font-medium",
                                isActive
                                  ? "text-text-primary"
                                  : "text-text-secondary",
                              )}
                            >
                              {opt.label}
                            </span>
                            <span className="text-text-tertiary text-xs leading-relaxed">
                              {opt.description}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* ─── Section: Task Statuses ─── */}
                <section className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <TagIcon className="text-accent-violet h-4 w-4" />
                    <h3 className="text-text-primary font-display text-sm font-medium">
                      Task Statuses
                    </h3>
                  </div>

                  <div className="bg-canvas-subtle/50 flex flex-wrap gap-2 rounded-xl border border-white/5 p-4">
                    {MOCK_STATUSES.map(status => (
                      <Badge
                        key={status.id}
                        tone={status.tone}
                        className="px-2.5 py-1 text-xs"
                      >
                        {status.label}
                      </Badge>
                    ))}
                    <button className="text-text-tertiary hover:text-text-secondary flex items-center gap-1 rounded-md border border-dashed border-white/10 px-2.5 py-1 text-xs transition-colors hover:bg-white/5">
                      + Add status
                    </button>
                  </div>
                </section>

                {/* ─── Section: Display Aliases ─── */}
                <section className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <Settings2 className="text-accent-cyan h-4 w-4" />
                    <h3 className="text-text-primary font-display text-sm font-medium">
                      Display Aliases
                    </h3>
                  </div>

                  <div className="bg-canvas-subtle/50 flex flex-col divide-y divide-white/5 rounded-xl border border-white/5">
                    {MOCK_TERMINOLOGY_ALIASES.map(alias => (
                      <div
                        key={alias.term}
                        className="flex items-center justify-between px-4 py-3"
                      >
                        <code className="text-text-tertiary font-mono text-xs">
                          {alias.term}
                        </code>
                        <span className="text-text-primary bg-canvas/50 rounded-md border border-white/5 px-2.5 py-1 text-sm">
                          {alias.alias}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-text-tertiary px-1 text-[11px] leading-relaxed">
                    Rename how model terms appear in the UI. Aliases are
                    presentation-only and don&apos;t affect data or behavior.
                  </p>
                </section>

                {/* ─── Section: Collections ─── */}
                <section className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <Layers className="text-accent-amber h-4 w-4" />
                    <h3 className="text-text-primary font-display text-sm font-medium">
                      Collections
                    </h3>
                  </div>

                  <div className="bg-canvas-subtle/50 flex flex-wrap gap-2 rounded-xl border border-white/5 p-4">
                    {MOCK_COLLECTIONS.map(collection => (
                      <Badge
                        key={collection}
                        tone="neutral"
                        className="border-white/10 bg-white/5 px-2.5 py-1 text-xs"
                      >
                        {collection}
                      </Badge>
                    ))}
                  </div>
                </section>

                {/* ─── Section: Default Labels ─── */}
                <section className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <TagIcon className="text-accent-green h-4 w-4" />
                    <h3 className="text-text-primary font-display text-sm font-medium">
                      Default Task Labels
                    </h3>
                  </div>

                  <div className="bg-canvas-subtle/50 flex flex-wrap items-center gap-2 rounded-xl border border-white/5 p-3">
                    {labels.map(label => (
                      <span
                        key={label}
                        className="text-text-primary flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs"
                      >
                        {label}
                        <button
                          type="button"
                          onClick={() => handleRemoveLabel(label)}
                          className="text-text-tertiary hover:text-accent-red transition-colors"
                          aria-label={`Remove ${label}`}
                        >
                          <XIcon className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      value={labelInput}
                      onChange={e => setLabelInput(e.target.value)}
                      onKeyDown={handleLabelKeyDown}
                      onBlur={handleAddLabel}
                      placeholder="Add label..."
                      className="text-text-secondary placeholder:text-text-tertiary/50 min-w-20 flex-1 bg-transparent py-1 text-xs outline-none"
                    />
                  </div>
                  <p className="text-text-tertiary px-1 text-[11px] leading-relaxed">
                    Labels added here are automatically applied to new tasks in
                    this project.
                  </p>
                </section>

                {/* ─── Section: Saved Views ─── */}
                <section className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <Save className="text-accent-amber h-4 w-4" />
                    <h3 className="text-text-primary font-display text-sm font-medium">
                      Saved Views
                    </h3>
                  </div>

                  <div className="bg-canvas-subtle/50 flex flex-col divide-y divide-white/5 rounded-xl border border-white/5">
                    {MOCK_SAVED_VIEWS.map(view => (
                      <div
                        key={view.id}
                        className="flex items-center justify-between px-4 py-3"
                      >
                        <span className="text-text-primary text-sm font-medium">
                          {view.name}
                        </span>
                        {view.isDefault && (
                          <Badge
                            tone="neutral"
                            className="bg-white/5 text-[10px]"
                          >
                            Default
                          </Badge>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
