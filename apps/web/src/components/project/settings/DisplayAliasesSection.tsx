import { Settings2 } from "lucide-react";

type DisplayAliasesSectionProps = {
  readonly taskLabel: string;
  readonly collectionLabel: string;
  readonly onTaskLabelChange: (value: string) => void;
  readonly onCollectionLabelChange: (value: string) => void;
};

export function DisplayAliasesSection({
  taskLabel,
  collectionLabel,
  onTaskLabelChange,
  onCollectionLabelChange,
}: DisplayAliasesSectionProps) {
  return (
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
            onChange={event => onTaskLabelChange(event.target.value)}
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
            onChange={event => onCollectionLabelChange(event.target.value)}
            className="text-text-primary bg-canvas focus:border-accent-amber/40 rounded-xl border border-white/10 px-3 py-2.5 text-sm transition-colors outline-none"
          />
        </label>

        <p className="text-text-tertiary text-sm leading-relaxed">
          Aliases are presentation-only. They change how the UI talks about work
          without changing the underlying model.
        </p>
      </div>
    </section>
  );
}
