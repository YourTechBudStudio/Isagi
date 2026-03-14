import type { HistoryFrame } from "@/lib/commands/types";

type CommandPaletteBadgeRowProps = {
  readonly commandLabel: string | null;
  readonly history: ReadonlyArray<HistoryFrame>;
};

export function CommandPaletteBadgeRow({
  commandLabel,
  history,
}: CommandPaletteBadgeRowProps) {
  const hasBadges = Boolean(commandLabel) || history.length > 0;

  if (!hasBadges) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {commandLabel && (
        <div className="bg-canvas-subtle font-body text-text-secondary flex items-center gap-1.5 rounded-md border border-white/5 px-2.5 py-1 text-sm transition-colors duration-150">
          {commandLabel}
        </div>
      )}

      {history.map(frame => {
        const prefix = frame.step.labelPrefix
          ? `${frame.step.labelPrefix} `
          : "";

        return (
          <div
            key={`${frame.step.id}-${frame.value.label}`}
            className="bg-accent-blue-soft border-accent-blue/20 font-body text-accent-blue flex items-center rounded-md border px-2.5 py-1 text-sm transition-colors duration-150"
          >
            <span className="mr-1 opacity-70">{prefix}</span>
            {frame.value.label}
          </div>
        );
      })}
    </div>
  );
}
