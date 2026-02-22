import type { CommandDef } from "@/lib/commands/types";

type CollectedArgs = Record<string, { value: string; label: string }>;

type CommandPaletteBadgeRowProps = {
  readonly activeCommand: CommandDef | null;
  readonly collectedArgs: CollectedArgs;
};

export function CommandPaletteBadgeRow({
  activeCommand,
  collectedArgs,
}: CommandPaletteBadgeRowProps) {
  const hasBadges =
    Boolean(activeCommand) || Object.keys(collectedArgs).length > 0;

  if (!hasBadges) return null;

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {activeCommand && (
        <div className="bg-canvas-subtle font-body text-text-secondary flex items-center gap-1.5 rounded-md border border-white/5 px-2.5 py-1 text-sm transition-colors duration-150">
          {activeCommand.label}
        </div>
      )}
      {Object.entries(collectedArgs).map(([key, argData]) => {
        const argDef = activeCommand?.arguments.find(arg => arg.id === key);
        const prefix = argDef?.labelPrefix ? `${argDef.labelPrefix} ` : "";

        return (
          <div
            key={key}
            className="bg-accent-blue-soft border-accent-blue/20 font-body text-accent-blue flex items-center rounded-md border px-2.5 py-1 text-sm transition-colors duration-150"
          >
            <span className="mr-1 opacity-70">{prefix}</span>
            {argData.label}
          </div>
        );
      })}
    </div>
  );
}
