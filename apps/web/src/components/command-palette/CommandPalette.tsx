import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { COMMANDS } from "../../lib/commands/registry";
import type { CommandArgument, CommandDef } from "../../lib/commands/types";
import type { SearchResult } from "../../lib/commands/useEntitySearch";
import { useEntitySearch } from "../../lib/commands/useEntitySearch";
import {
  useCommandPaletteActions,
  useCommandPaletteIsOpen,
} from "../../stores/useCommandPalette";

function getEmptyStateMessage() {
  const messages = [
    "404: Imagination not found.",
    "Nothing matches. Suspicious. I will allow it.",
    "I searched my entire context window. Nothing.",
    "Cache miss. And by cache, I mean reality.",
    "That does not exist. Should I hallucinate it for you?",
  ];
  return messages[Math.floor(Math.random() * messages.length)];
}

export function CommandPalette() {
  const isOpen = useCommandPaletteIsOpen();
  const { close, open } = useCommandPaletteActions();

  const [inputText, setInputText] = useState("");
  const [activeCommand, setActiveCommand] = useState<CommandDef | null>(null);
  const [collectedArgs, setCollectedArgs] = useState<
    Record<string, { value: string; label: string }>
  >({});
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut listener for Cmd+K / Cmd+Shift+P
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key === "k";
      const isCmdShiftP =
        (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p";

      if (isCmdK || isCmdShiftP) {
        e.preventDefault();
        open();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Determine current expected argument (if any)
  const currentArgIndex = Object.keys(collectedArgs).length;
  const currentArg: CommandArgument | null =
    activeCommand?.arguments[currentArgIndex] || null;

  // We want to reset highlightedIndex to 0 whenever the search results change.
  // Instead of using useEffect (which causes cascading renders), we track the
  // previous search key and reset the state during render if it changed.
  const searchKey = `${inputText}-${activeCommand?.id}-${currentArgIndex}`;
  const [prevSearchKey, setPrevSearchKey] = useState(searchKey);

  if (searchKey !== prevSearchKey) {
    setPrevSearchKey(searchKey);
    setHighlightedIndex(0);
  }

  // Derive search context
  const { recommended, results } = useEntitySearch(
    currentArg?.type || null,
    inputText,
    currentArg?.type === "project" ? "project-1" : undefined, // Mocking context: assuming we are in project-1
  );

  const allVisibleOptions = [...recommended, ...results];

  // Cleanup local state when closing
  const handleClose = useCallback(() => {
    close();
    setTimeout(() => {
      setInputText("");
      setActiveCommand(null);
      setCollectedArgs({});
      setHighlightedIndex(0);
    }, 200); // Wait for exit animation
  }, [close]);

  // Execute Command
  const executeCommand = useCallback(
    (
      cmd: CommandDef,
      args: Record<string, { value: string; label: string }>,
    ) => {
      // In a real app, this would dispatch an event or call a handler
      console.log("🚀 EXECUTE COMMAND", { command: cmd.id, args });
      handleClose();
    },
    [handleClose],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex(prev =>
        Math.min(prev + 1, allVisibleOptions.length - 1),
      );
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex(prev => Math.max(prev - 1, 0));
      return;
    }

    if (e.key === "Backspace" && inputText === "") {
      e.preventDefault();
      if (currentArgIndex > 0) {
        // Pop last arg
        const keys = Object.keys(collectedArgs);
        const lastKey = keys[keys.length - 1];
        if (lastKey) {
          const newArgs = { ...collectedArgs };
          delete newArgs[lastKey];
          setCollectedArgs(newArgs);
        }
      } else if (activeCommand) {
        // Clear command
        setActiveCommand(null);
      } else {
        // Close
        handleClose();
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();

      // Case 1: Picking a command
      if (!activeCommand) {
        const selected = allVisibleOptions[highlightedIndex];
        if (selected) {
          const cmd = COMMANDS.find(c => c.id === selected.id);
          if (cmd) {
            setActiveCommand(cmd);
            setInputText("");

            // If the command has no arguments, execute immediately
            if (cmd.arguments.length === 0) {
              executeCommand(cmd, {});
            }
          }
        }
        return;
      }

      // Case 2: Command is selected, we need an argument
      if (currentArg) {
        if (currentArg.type === "text") {
          // Free text entry
          if (inputText.trim()) {
            const nextArgs = {
              ...collectedArgs,
              [currentArg.id]: {
                value: inputText.trim(),
                label: inputText.trim(),
              },
            };
            setCollectedArgs(nextArgs);
            setInputText("");

            // Check if we are done
            if (
              Object.keys(nextArgs).length === activeCommand.arguments.length
            ) {
              executeCommand(activeCommand, nextArgs);
            }
          }
        } else {
          // Entity selection
          const selected = allVisibleOptions[highlightedIndex];
          if (selected) {
            const nextArgs = {
              ...collectedArgs,
              [currentArg.id]: { value: selected.id, label: selected.label },
            };
            setCollectedArgs(nextArgs);
            setInputText("");

            // Check if we are done
            if (
              Object.keys(nextArgs).length === activeCommand.arguments.length
            ) {
              executeCommand(activeCommand, nextArgs);
            }
          }
        }
      }
    }
  };

  const placeholderText = currentArg?.placeholder || "Type a command...";

  // Render Option helper
  const renderOption = (
    item: SearchResult,
    index: number,
    isRecommended = false,
  ) => {
    const isHighlighted = index === highlightedIndex;
    return (
      <div
        key={item.id}
        className={`flex cursor-pointer items-center gap-3 border-l-2 px-4 py-3 select-none ${
          isHighlighted
            ? "bg-canvas-subtle border-accent-blue"
            : "border-transparent"
        }`}
        onMouseEnter={() => setHighlightedIndex(index)}
        onClick={() => {
          // Trigger the Enter key flow manually
          const fakeEvent = new KeyboardEvent("keydown", { key: "Enter" });
          handleKeyDown(fakeEvent as any); // Type hacking for simplicity
        }}
      >
        <span className="text-text-primary font-body">{item.label}</span>
        {isRecommended && (
          <span className="text-text-tertiary font-body ml-auto text-xs tracking-wider uppercase">
            Suggested
          </span>
        )}
        {isHighlighted && !isRecommended && (
          <span className="text-text-tertiary font-body ml-auto text-xs tracking-wider uppercase">
            Select ↵
          </span>
        )}
      </div>
    );
  };

  // Skip dropdown rendering entirely if argument type is text
  const shouldHideDropdown = currentArg?.type === "text";

  const modal = (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          key="command-palette-backdrop"
          className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[20vh]"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="bg-canvas/60 absolute inset-0 backdrop-blur-sm"
            onClick={handleClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -5 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="bg-canvas-elevated relative flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
            // Stop clicks inside modal from closing it
            onClick={e => e.stopPropagation()}
          >
            {/* Input Area */}
            <div className="border-b border-white/5 p-4">
              <input
                ref={inputRef}
                type="text"
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholderText}
                className="text-text-primary font-display placeholder:text-text-tertiary placeholder:font-body w-full bg-transparent text-2xl placeholder:text-xl focus:outline-none"
              />

              {/* Badges Row */}
              {(activeCommand || Object.keys(collectedArgs).length > 0) && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {activeCommand && (
                    <div className="bg-canvas-subtle font-body text-text-secondary flex items-center gap-1.5 rounded-md border border-white/5 px-2.5 py-1 text-sm">
                      {activeCommand.label}
                    </div>
                  )}
                  {Object.entries(collectedArgs).map(([key, argData]) => {
                    const argDef = activeCommand?.arguments.find(
                      a => a.id === key,
                    );
                    const prefix = argDef?.labelPrefix
                      ? `${argDef.labelPrefix} `
                      : "";
                    return (
                      <div
                        key={key}
                        className="bg-accent-blue-soft border-accent-blue/20 font-body text-accent-blue flex items-center rounded-md border px-2.5 py-1 text-sm"
                      >
                        <span className="mr-1 opacity-70">{prefix}</span>
                        {argData.label}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Dropdown Area */}
            {!shouldHideDropdown && (
              <div className="max-h-[40vh] overflow-y-auto overscroll-contain">
                {allVisibleOptions.length === 0 ? (
                  <div className="text-text-tertiary font-body p-8 text-center">
                    {getEmptyStateMessage()}
                  </div>
                ) : (
                  <div className="py-2">
                    {recommended.length > 0 && (
                      <>
                        <div className="font-display text-text-tertiary px-4 py-1.5 text-xs tracking-wider">
                          Context
                        </div>
                        {recommended.map((item, i) =>
                          renderOption(item, i, true),
                        )}
                        {results.length > 0 && (
                          <div className="mx-4 my-2 border-t border-white/5" />
                        )}
                      </>
                    )}
                    {results.length > 0 && (
                      <>
                        {recommended.length > 0 && (
                          <div className="font-display text-text-tertiary px-4 py-1.5 text-xs tracking-wider">
                            Other options
                          </div>
                        )}
                        {results.map((item, i) =>
                          renderOption(item, i + recommended.length),
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Helper text for 'text' input mode */}
            {shouldHideDropdown && (
              <div className="bg-canvas/30 font-body text-text-tertiary flex items-center border-t border-white/5 px-4 py-3 text-sm">
                <span className="mr-2 opacity-70">Press</span>
                <kbd className="text-text-primary mr-2 rounded border border-white/10 bg-white/10 px-1.5 py-0.5 text-xs shadow-sm">
                  Enter
                </kbd>
                <span className="opacity-70">to submit</span>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  // Render at the root level using portal
  if (typeof document === "undefined") return null; // SSR safety
  return createPortal(modal, document.body);
}
