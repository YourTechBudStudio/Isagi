import type React from "react";
import { useEffect, useRef } from "react";

import { CommandPaletteBadgeRow } from "@/components/command-palette/CommandPaletteBadgeRow";
import { Button } from "@/components/ui/Button";
import type { CommandStep, HistoryFrame } from "@/lib/commands/types";

type CommandPaletteInputProps = {
  readonly inputRef: React.RefObject<
    HTMLInputElement | HTMLTextAreaElement | null
  >;
  readonly inputText: string;
  readonly placeholder: string;
  readonly commandLabel: string | null;
  readonly history: ReadonlyArray<HistoryFrame>;
  readonly currentStep: CommandStep | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  readonly onHelperAction: () => void;
};

export function CommandPaletteInput({
  inputRef,
  inputText,
  placeholder,
  commandLabel,
  history,
  currentStep,
  error,
  isLoading,
  onChange,
  onKeyDown,
  onHelperAction,
}: CommandPaletteInputProps) {
  const isMarkdown = currentStep?.kind === "markdown";
  const showsFilePickerButton = currentStep?.kind === "file";
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isMarkdown && inputRef && "current" in inputRef) {
      inputRef.current = internalTextareaRef.current;
    }
  }, [inputRef, isMarkdown]);

  useEffect(() => {
    if (!isMarkdown) {
      return;
    }

    const element = internalTextareaRef.current;
    if (!element) {
      return;
    }

    requestAnimationFrame(() => {
      element.focus();
      const end = element.value.length;
      element.setSelectionRange(end, end);
    });
  }, [isMarkdown]);

  useEffect(() => {
    if (isMarkdown && internalTextareaRef.current) {
      internalTextareaRef.current.style.height = "auto";
      internalTextareaRef.current.style.height = `${internalTextareaRef.current.scrollHeight}px`;
    }
  }, [inputText, isMarkdown]);

  const handleMarkdownKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    onKeyDown(event);
    if (event.defaultPrevented) {
      return;
    }

    if (
      event.key === "Enter" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey
    ) {
      event.preventDefault();

      const target = event.currentTarget;
      const start = target.selectionStart;
      const value = target.value;
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
        nextPrefix =
          rest.trim().length === 0 ? indent : `${indent}${bullet}${spacing}`;
      } else if (indentOnlyMatch) {
        nextPrefix = indentOnlyMatch[1] || "";
      }

      const newValue =
        value.slice(0, start) + "\n" + nextPrefix + value.slice(start);
      onChange(newValue);

      window.setTimeout(() => {
        target.selectionStart = target.selectionEnd =
          start + 1 + nextPrefix.length;
      }, 0);
    }
  };

  return (
    <div className="border-b border-white/5 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {isMarkdown ? (
            <textarea
              ref={internalTextareaRef}
              value={inputText}
              onChange={event => onChange(event.target.value)}
              onKeyDown={handleMarkdownKeyDown}
              placeholder={placeholder}
              className="text-text-primary font-display placeholder:text-text-tertiary placeholder:font-body max-h-[60vh] min-h-10 w-full resize-none bg-transparent text-lg placeholder:text-lg focus:outline-none"
              rows={1}
            />
          ) : (
            <input
              ref={element => {
                inputRef.current = element;
              }}
              type="text"
              value={inputText}
              onChange={event => onChange(event.target.value)}
              onKeyDown={
                onKeyDown as React.KeyboardEventHandler<HTMLInputElement>
              }
              placeholder={placeholder}
              className="text-text-primary font-display placeholder:text-text-tertiary placeholder:font-body w-full bg-transparent text-2xl placeholder:text-xl focus:outline-none"
            />
          )}
        </div>

        {showsFilePickerButton && (
          <Button
            variant="secondary"
            size="sm"
            disabled={isLoading}
            onClick={onHelperAction}
          >
            Select
          </Button>
        )}
      </div>

      {error && (
        <div className="text-accent-red font-body mt-3 text-sm">{error}</div>
      )}

      <CommandPaletteBadgeRow commandLabel={commandLabel} history={history} />
    </div>
  );
}
