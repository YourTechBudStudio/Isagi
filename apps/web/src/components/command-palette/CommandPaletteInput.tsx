import type React from "react";
import { useEffect, useRef } from "react";

import { CommandPaletteBadgeRow } from "@/components/command-palette/CommandPaletteBadgeRow";
import type { ArgumentType, CommandDef } from "@/lib/commands/types";

type CollectedArgs = Record<string, { value: string; label: string }>;

type CommandPaletteInputProps = {
  readonly inputRef: React.RefObject<any>;
  readonly inputText: string;
  readonly placeholder: string;
  readonly activeCommand: CommandDef | null;
  readonly collectedArgs: CollectedArgs;
  readonly currentArgType?: ArgumentType;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
};

export function CommandPaletteInput({
  inputRef,
  inputText,
  placeholder,
  activeCommand,
  collectedArgs,
  currentArgType,
  onChange,
  onKeyDown,
}: CommandPaletteInputProps) {
  const isMarkdown = currentArgType === "markdown";
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync refs if it's a textarea
  useEffect(() => {
    if (isMarkdown && inputRef && "current" in inputRef) {
      inputRef.current = internalTextareaRef.current;
    }
  }, [isMarkdown, inputRef]);

  useEffect(() => {
    if (!isMarkdown) return;
    const element = internalTextareaRef.current;
    if (!element) return;

    requestAnimationFrame(() => {
      element.focus();
      const end = element.value.length;
      element.setSelectionRange(end, end);
    });
  }, [isMarkdown]);

  // Auto-resize textarea
  useEffect(() => {
    if (isMarkdown && internalTextareaRef.current) {
      internalTextareaRef.current.style.height = "auto";
      internalTextareaRef.current.style.height = `${internalTextareaRef.current.scrollHeight}px`;
    }
  }, [inputText, isMarkdown]);

  const handleMarkdownKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    onKeyDown(e);
    if (e.defaultPrevented) return;

    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();

      const target = e.currentTarget;
      const start = target.selectionStart;
      const value = target.value;

      // Find the current line
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const currentLine = value.slice(lineStart, start);

      const orderedMatch = currentLine.match(/^(\s*)(\d+)([.)])(\s+)(.*)$/);
      const unorderedMatch = currentLine.match(/^(\s*)([-*+])(\s+)(.*)$/);
      const indentOnlyMatch = currentLine.match(/^(\s+)$/);

      let nextPrefix = "";

      if (orderedMatch) {
        const [, indent, numberText, delimiter, spacing, rest] = orderedMatch;
        if (rest.trim().length === 0) {
          nextPrefix = indent;
        } else {
          const parsedNumber = Number.parseInt(numberText, 10);
          const nextNumber = Number.isNaN(parsedNumber)
            ? numberText
            : String(parsedNumber + 1);
          const paddedNumber =
            numberText.length > 1 && numberText.startsWith("0")
              ? nextNumber.padStart(numberText.length, "0")
              : nextNumber;
          nextPrefix = `${indent}${paddedNumber}${delimiter}${spacing}`;
        }
      } else if (unorderedMatch) {
        const [, indent, bullet, spacing, rest] = unorderedMatch;
        if (rest.trim().length === 0) {
          nextPrefix = indent;
        } else {
          nextPrefix = `${indent}${bullet}${spacing}`;
        }
      } else if (indentOnlyMatch) {
        nextPrefix = indentOnlyMatch[1] || "";
      }

      const newValue =
        value.slice(0, start) + "\n" + nextPrefix + value.slice(start);
      onChange(newValue);

      // Move cursor after the prefix
      setTimeout(() => {
        target.selectionStart = target.selectionEnd =
          start + 1 + nextPrefix.length;
      }, 0);
    }
  };

  return (
    <div className="border-b border-white/5 p-4">
      {isMarkdown ? (
        <textarea
          ref={internalTextareaRef}
          value={inputText}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleMarkdownKeyDown}
          placeholder={placeholder}
          className="text-text-primary font-display placeholder:text-text-tertiary placeholder:font-body w-full resize-none bg-transparent text-lg placeholder:text-lg focus:outline-none"
          style={{ minHeight: "40px", maxHeight: "60vh" }}
          rows={1}
        />
      ) : (
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={e => onChange(e.target.value)}
          onKeyDown={onKeyDown as React.KeyboardEventHandler<HTMLInputElement>}
          placeholder={placeholder}
          className="text-text-primary font-display placeholder:text-text-tertiary placeholder:font-body w-full bg-transparent text-2xl placeholder:text-xl focus:outline-none"
        />
      )}
      <CommandPaletteBadgeRow
        activeCommand={activeCommand}
        collectedArgs={collectedArgs}
      />
    </div>
  );
}
