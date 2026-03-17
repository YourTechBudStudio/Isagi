import { AlertTriangle, GitBranch, PencilLine } from "lucide-react";

import { Button } from "@/components/ui/Button";

type RepositorySectionProps = {
  readonly repoPath: string;
  readonly draftRepoPath: string;
  readonly isRepoEditorOpen: boolean;
  readonly onOpenEditor: () => void;
  readonly onDraftChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
};

export function RepositorySection({
  repoPath,
  draftRepoPath,
  isRepoEditorOpen,
  onOpenEditor,
  onDraftChange,
  onCancel,
  onConfirm,
}: RepositorySectionProps) {
  return (
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
            onClick={onOpenEditor}
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
                  <li>Archived sessions can no longer be resumed.</li>
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
                onChange={event => onDraftChange(event.target.value)}
                className="text-text-primary placeholder:text-text-tertiary/50 bg-canvas focus:border-accent-red/40 rounded-xl border border-white/10 px-3 py-2.5 text-sm transition-colors outline-none"
                placeholder="/path/to/repository"
              />
            </label>

            <div className="flex items-center gap-2">
              <Button variant="secondary" size="md" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                className="bg-accent-red text-canvas hover:bg-accent-red/90"
                onClick={onConfirm}
              >
                Confirm path change
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
