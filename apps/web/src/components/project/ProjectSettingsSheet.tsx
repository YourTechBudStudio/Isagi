import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  GitBranch,
  GitFork,
  MessageSquareMore,
  PencilLine,
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
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/cn";

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

type StatusBucket = "todo" | "in_progress" | "done";

type EditableStatus = {
  readonly id: string;
  readonly bucket: StatusBucket;
  readonly name: string;
};

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
    icon: Workflow,
    activeColor: "text-accent-cyan",
  },
];

const INITIAL_STATUSES: Array<EditableStatus> = [
  { id: "todo", name: "To Do", bucket: "todo" },
  { id: "in_progress", name: "In Progress", bucket: "in_progress" },
  { id: "in_review", name: "In Review", bucket: "in_progress" },
  { id: "done", name: "Done", bucket: "done" },
];

function getBucketTone(bucket: StatusBucket): "neutral" | "blue" | "green" {
  if (bucket === "in_progress") {
    return "blue";
  }

  if (bucket === "done") {
    return "green";
  }

  return "neutral";
}

function getBucketLabel(bucket: StatusBucket): string {
  if (bucket === "in_progress") {
    return "In Progress";
  }

  if (bucket === "done") {
    return "Done";
  }

  return "To Do";
}

function getInitialRepoPath(projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `/home/yourtechbud/work/projects/${slug.replace(/^-|-$/g, "")}`;
}

export function ProjectSettingsSheet({
  isOpen,
  onClose,
  projectName,
}: ProjectSettingsSheetProps) {
  const [gitMode, setGitMode] = useState<GitMode>("global_default");
  const [repoPath, setRepoPath] = useState(() =>
    getInitialRepoPath(projectName),
  );
  const [draftRepoPath, setDraftRepoPath] = useState(repoPath);
  const [isRepoEditorOpen, setIsRepoEditorOpen] = useState(false);
  const [statuses, setStatuses] = useState<Array<EditableStatus>>(() => [
    ...INITIAL_STATUSES,
  ]);
  const [newStatusName, setNewStatusName] = useState("");
  const [taskLabel, setTaskLabel] = useState("Task");
  const [collectionLabel, setCollectionLabel] = useState("Milestone");

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleOpenRepoEditor = () => {
    setDraftRepoPath(repoPath);
    setIsRepoEditorOpen(true);
  };

  const handleSaveRepoPath = () => {
    const trimmedPath = draftRepoPath.trim();
    if (!trimmedPath) {
      return;
    }

    setRepoPath(trimmedPath);
    setIsRepoEditorOpen(false);
  };

  const handleStatusNameChange = (statusId: string, name: string) => {
    setStatuses(prev =>
      prev.map(status =>
        status.id === statusId ? { ...status, name } : status,
      ),
    );
  };

  const handleStatusBucketChange = (statusId: string, bucket: StatusBucket) => {
    setStatuses(prev =>
      prev.map(status =>
        status.id === statusId ? { ...status, bucket } : status,
      ),
    );
  };

  const handleMoveStatus = (statusId: string, direction: "up" | "down") => {
    setStatuses(prev => {
      const index = prev.findIndex(status => status.id === statusId);
      if (index === -1) {
        return prev;
      }

      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) {
        return prev;
      }

      const next = [...prev];
      const [movedStatus] = next.splice(index, 1);
      next.splice(targetIndex, 0, movedStatus);
      return next;
    });
  };

  const handleDeleteStatus = (statusId: string) => {
    setStatuses(prev => prev.filter(status => status.id !== statusId));
  };

  const handleAddStatus = () => {
    const trimmedName = newStatusName.trim();
    if (!trimmedName) {
      return;
    }

    setStatuses(prev => [
      ...prev,
      {
        id: `status-${Date.now()}`,
        name: trimmedName,
        bucket: "todo",
      },
    ]);
    setNewStatusName("");
  };

  return (
    <>
      <motion.div
        animate={{ width: isOpen ? PROJECT_SETTINGS_SHEET_WIDTH : 0 }}
        transition={projectSettingsSheetTransition}
        className="shrink-0"
      />

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

            <div className="flex-1 overflow-y-auto p-6">
              <div className="flex flex-col gap-8">
                <section className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <GitBranch className="text-accent-blue h-4 w-4" />
                    <h3 className="text-text-primary font-display text-sm font-medium">
                      Repository
                    </h3>
                  </div>

                  <div className="bg-canvas-subtle/50 flex flex-col gap-4 rounded-2xl border border-white/5 p-4">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
                        Registered Repo Path
                      </span>
                      <code className="text-text-primary bg-canvas/60 rounded-xl border border-white/5 px-3 py-2.5 font-mono text-[13px] leading-relaxed break-all">
                        {repoPath}
                      </code>
                    </div>

                    {!isRepoEditorOpen ? (
                      <Button
                        variant="secondary"
                        size="md"
                        leadingIcon={<PencilLine className="h-4 w-4" />}
                        className="self-start"
                        onClick={handleOpenRepoEditor}
                      >
                        Change repo path
                      </Button>
                    ) : (
                      <div className="border-accent-red/20 bg-accent-red/8 flex flex-col gap-4 rounded-2xl border p-4">
                        <div className="flex items-start gap-3">
                          <AlertTriangle className="text-accent-red mt-0.5 h-4 w-4 shrink-0" />
                          <div className="flex flex-col gap-2">
                            <p className="text-text-primary text-sm font-medium">
                              Changing the repo path is high risk.
                            </p>
                            <ul className="text-text-secondary list-disc space-y-1 pl-4 text-sm leading-relaxed">
                              <li>Tasks stay attached to this project.</li>
                              <li>Existing sessions are archived.</li>
                              <li>
                                Archived sessions can no longer be resumed.
                              </li>
                            </ul>
                          </div>
                        </div>

                        <label className="flex flex-col gap-1.5">
                          <span className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
                            New Repo Path
                          </span>
                          <input
                            type="text"
                            value={draftRepoPath}
                            onChange={event =>
                              setDraftRepoPath(event.target.value)
                            }
                            className="text-text-primary placeholder:text-text-tertiary/50 bg-canvas focus:border-accent-red/40 rounded-xl border border-white/10 px-3 py-2.5 text-sm transition-colors outline-none"
                            placeholder="/path/to/repository"
                          />
                        </label>

                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="md"
                            onClick={() => {
                              setDraftRepoPath(repoPath);
                              setIsRepoEditorOpen(false);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="primary"
                            size="md"
                            className="bg-accent-red text-canvas hover:bg-accent-red/90"
                            onClick={handleSaveRepoPath}
                          >
                            Confirm path change
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                <section className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <Workflow className="text-accent-cyan h-4 w-4" />
                    <h3 className="text-text-primary font-display text-sm font-medium">
                      Default Git Mode
                    </h3>
                  </div>

                  <div className="bg-canvas-subtle/50 flex flex-col gap-1 rounded-2xl border border-white/5 p-1">
                    {GIT_MODE_OPTIONS.map(option => {
                      const isActive = gitMode === option.value;
                      const Icon = option.icon;

                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setGitMode(option.value)}
                          className={cn(
                            "flex items-start gap-3 rounded-xl px-4 py-3 text-left transition-colors",
                            isActive
                              ? "bg-canvas border border-white/5 shadow-sm"
                              : "border border-transparent hover:bg-white/5",
                          )}
                        >
                          <Icon
                            className={cn(
                              "mt-0.5 h-4 w-4 shrink-0",
                              isActive
                                ? option.activeColor
                                : "text-text-tertiary",
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
                              {option.label}
                            </span>
                            <span className="text-text-tertiary text-xs leading-relaxed">
                              {option.description}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <TagIcon className="text-accent-violet h-4 w-4" />
                    <h3 className="text-text-primary font-display text-sm font-medium">
                      Task Statuses
                    </h3>
                  </div>

                  <div className="bg-canvas-subtle/50 flex flex-col gap-3 rounded-2xl border border-white/5 p-4">
                    {statuses.map((status, index) => (
                      <div
                        key={status.id}
                        className="bg-canvas/50 flex items-center gap-3 rounded-2xl border border-white/5 px-3 py-3"
                      >
                        <div className="flex flex-col gap-1">
                          <IconButton
                            icon={<ArrowUp className="h-3.5 w-3.5" />}
                            variant="subtle"
                            aria-label={`Move ${status.name} up`}
                            onClick={() => handleMoveStatus(status.id, "up")}
                            disabled={index === 0}
                          />
                          <IconButton
                            icon={<ArrowDown className="h-3.5 w-3.5" />}
                            variant="subtle"
                            aria-label={`Move ${status.name} down`}
                            onClick={() => handleMoveStatus(status.id, "down")}
                            disabled={index === statuses.length - 1}
                          />
                        </div>

                        <div className="flex min-w-0 flex-1 flex-col gap-3">
                          <div className="flex items-center gap-3">
                            <input
                              type="text"
                              value={status.name}
                              onChange={event =>
                                handleStatusNameChange(
                                  status.id,
                                  event.target.value,
                                )
                              }
                              className="text-text-primary bg-canvas focus:border-accent-blue/40 min-w-0 flex-1 rounded-xl border border-white/10 px-3 py-2 text-sm transition-colors outline-none"
                            />
                            <Badge tone={getBucketTone(status.bucket)}>
                              {getBucketLabel(status.bucket)}
                            </Badge>
                          </div>

                          <div className="flex items-center justify-between gap-3">
                            <label className="flex items-center gap-2 text-sm">
                              <span className="text-text-tertiary">Bucket</span>
                              <select
                                value={status.bucket}
                                onChange={event =>
                                  handleStatusBucketChange(
                                    status.id,
                                    event.target.value as StatusBucket,
                                  )
                                }
                                className="text-text-primary bg-canvas focus:border-accent-blue/40 rounded-lg border border-white/10 px-2.5 py-1.5 text-sm transition-colors outline-none"
                              >
                                <option value="todo">To Do</option>
                                <option value="in_progress">In Progress</option>
                                <option value="done">Done</option>
                              </select>
                            </label>

                            <button
                              type="button"
                              onClick={() => handleDeleteStatus(status.id)}
                              className="text-text-tertiary hover:text-accent-red text-sm font-medium transition-colors"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}

                    <div className="flex items-center gap-2 rounded-2xl border border-dashed border-white/10 px-3 py-3">
                      <input
                        type="text"
                        value={newStatusName}
                        onChange={event => setNewStatusName(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            handleAddStatus();
                          }
                        }}
                        placeholder="Add status..."
                        className="text-text-primary placeholder:text-text-tertiary/50 min-w-0 flex-1 bg-transparent text-sm outline-none"
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleAddStatus}
                      >
                        Add status
                      </Button>
                    </div>
                  </div>
                </section>

                <section className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <Settings2 className="text-accent-amber h-4 w-4" />
                    <h3 className="text-text-primary font-display text-sm font-medium">
                      Display Aliases
                    </h3>
                  </div>

                  <div className="bg-canvas-subtle/50 flex flex-col gap-4 rounded-2xl border border-white/5 p-4">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
                        Task Label
                      </span>
                      <input
                        type="text"
                        value={taskLabel}
                        onChange={event => setTaskLabel(event.target.value)}
                        className="text-text-primary bg-canvas focus:border-accent-amber/40 rounded-xl border border-white/10 px-3 py-2.5 text-sm transition-colors outline-none"
                      />
                    </label>

                    <label className="flex flex-col gap-1.5">
                      <span className="text-text-tertiary text-[11px] font-medium tracking-wider uppercase">
                        Collection Label
                      </span>
                      <input
                        type="text"
                        value={collectionLabel}
                        onChange={event =>
                          setCollectionLabel(event.target.value)
                        }
                        className="text-text-primary bg-canvas focus:border-accent-amber/40 rounded-xl border border-white/10 px-3 py-2.5 text-sm transition-colors outline-none"
                      />
                    </label>

                    <p className="text-text-tertiary text-sm leading-relaxed">
                      Aliases are presentation-only. They change how the UI
                      talks about work without changing the underlying model.
                    </p>
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
