import type React from "react";

import { CommandPaletteBadgeRow } from "@/components/command-palette/CommandPaletteBadgeRow";
import type { CommandDef } from "@/lib/commands/types";

type CollectedArgs = Record<string, { value: string; label: string }>;

type CommandPaletteInputProps = {
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly inputText: string;
  readonly placeholder: string;
  readonly activeCommand: CommandDef | null;
  readonly collectedArgs: CollectedArgs;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
};

export function CommandPaletteInput({
  inputRef,
  inputText,
  placeholder,
  activeCommand,
  collectedArgs,
  onChange,
  onKeyDown,
}: CommandPaletteInputProps) {
  return (
    <div className="border-b border-white/5 p-4">
      <input
        ref={inputRef}
        type="text"
        value={inputText}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="text-text-primary font-display placeholder:text-text-tertiary placeholder:font-body w-full bg-transparent text-2xl placeholder:text-xl focus:outline-none"
      />
      <CommandPaletteBadgeRow
        activeCommand={activeCommand}
        collectedArgs={collectedArgs}
      />
    </div>
  );
}
