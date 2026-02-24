import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { CommandPaletteDropdown } from "@/components/command-palette/CommandPaletteDropdown";
import { CommandPaletteInput } from "@/components/command-palette/CommandPaletteInput";
import { COMMANDS } from "@/lib/commands/registry";
import type { SearchResult } from "@/lib/commands/searchEntities";
import { searchEntities } from "@/lib/commands/searchEntities";
import type { CommandArgument, CommandDef } from "@/lib/commands/types";
import {
  useCommandPaletteActions,
  useCommandPaletteIsOpen,
} from "@/stores/commandPalette.selectors";

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

type CollectedArgs = Record<string, { value: string; label: string }>;

export function CommandPalette() {
  const isOpen = useCommandPaletteIsOpen();
  const { close, open } = useCommandPaletteActions();
  const shouldReduceMotion = useReducedMotion();

  const [inputText, setInputText] = useState("");
  const [activeCommand, setActiveCommand] = useState<CommandDef | null>(null);
  const [collectedArgs, setCollectedArgs] = useState<CollectedArgs>({});
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const resetHighlight = () => setHighlightedIndex(0);

  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  // Keyboard shortcut listener for Cmd/Ctrl + K, Cmd/Ctrl + P, Cmd/Ctrl + N
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      const isCmdP =
        (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "p";
      const isCmdN = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n";

      if (isCmdK || isCmdP) {
        e.preventDefault();
        open();
      } else if (isCmdN) {
        e.preventDefault();
        const cmd = COMMANDS.find(c => c.id === "capture-spark");
        if (cmd) {
          setActiveCommand(cmd);
          setCollectedArgs({});
          setInputText("");
          resetHighlight();
        }
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

  // Derive search context
  const { recommended, results } = searchEntities(
    currentArg?.type || null,
    inputText,
    currentArg?.type === "project" ? "project-1" : undefined,
  );

  const allVisibleOptions = [...recommended, ...results];

  const handleClose = () => {
    close();
    setTimeout(() => {
      setInputText("");
      setActiveCommand(null);
      setCollectedArgs({});
      setHighlightedIndex(0);
    }, 200);
  };

  const executeCommand = (cmd: CommandDef, args: CollectedArgs) => {
    console.log("\uD83D\uDE80 EXECUTE COMMAND", { command: cmd.id, args });
    handleClose();

    if (cmd.id === "capture-spark") {
      toast.success("Spark captured.", {
        action: {
          label: "Open triage now",
          onClick: () => console.log("Open triage clicked"),
        },
      });
    }
  };

  const handleSelectCommand = (selected: SearchResult) => {
    const cmd = COMMANDS.find(c => c.id === selected.id);
    if (!cmd) return;

    setActiveCommand(cmd);
    setInputText("");
    resetHighlight();

    if (cmd.arguments.length === 0) {
      executeCommand(cmd, {});
    }
  };

  const handleSelectArgument = (selected: SearchResult) => {
    if (!activeCommand || !currentArg) return;

    const nextArgs = {
      ...collectedArgs,
      [currentArg.id]: { value: selected.id, label: selected.label },
    };

    setCollectedArgs(nextArgs);
    setInputText("");
    resetHighlight();

    if (Object.keys(nextArgs).length === activeCommand.arguments.length) {
      executeCommand(activeCommand, nextArgs);
    }
  };

  const handleEnterForTextOrMarkdown = (isCmdOrCtrl: boolean = false) => {
    if (!activeCommand || !currentArg) return;

    if (currentArg.type === "markdown" && !isCmdOrCtrl) {
      return;
    }

    if (!inputText.trim()) {
      if (currentArg.type === "markdown") {
        toast.error("You cannot submit an empty spark.");
      }
      return;
    }

    const nextArgs = {
      ...collectedArgs,
      [currentArg.id]: { value: inputText.trim(), label: inputText.trim() },
    };

    setCollectedArgs(nextArgs);
    setInputText("");
    resetHighlight();

    if (Object.keys(nextArgs).length === activeCommand.arguments.length) {
      executeCommand(activeCommand, nextArgs);
    }
  };

  const handleOptionSelect = (index: number) => {
    const selected = allVisibleOptions[index];
    if (!selected) return;

    if (!activeCommand) {
      handleSelectCommand(selected);
      return;
    }

    if (currentArg?.type === "text" || currentArg?.type === "markdown") {
      // In option selection via enter, it's not a cmd+enter
      handleEnterForTextOrMarkdown();
      return;
    }

    handleSelectArgument(selected);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (currentArg?.type === "markdown" && inputText.trim()) {
        if (!window.confirm("Discard this spark?")) {
          e.preventDefault();
          return;
        }
      }
      e.preventDefault();
      handleClose();
      return;
    }

    if (e.key === "ArrowDown") {
      if (currentArg?.type === "markdown") return; // Allow normal textarea navigation
      e.preventDefault();
      if (allVisibleOptions.length === 0) return;
      setHighlightedIndex(prev =>
        Math.min(prev + 1, allVisibleOptions.length - 1),
      );
      return;
    }

    if (e.key === "ArrowUp") {
      if (currentArg?.type === "markdown") return; // Allow normal textarea navigation
      e.preventDefault();
      if (allVisibleOptions.length === 0) return;
      setHighlightedIndex(prev => Math.max(prev - 1, 0));
      return;
    }

    if (e.key === "Backspace" && inputText === "") {
      e.preventDefault();
      if (currentArgIndex > 0) {
        const keys = Object.keys(collectedArgs);
        const lastKey = keys[keys.length - 1];
        if (lastKey) {
          const newArgs = { ...collectedArgs };
          delete newArgs[lastKey];
          setCollectedArgs(newArgs);
          resetHighlight();
        }
      } else if (activeCommand) {
        setActiveCommand(null);
        resetHighlight();
      } else {
        handleClose();
      }
      return;
    }

    if (e.key === "Enter") {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;

      if (currentArg?.type === "markdown" && !isCmdOrCtrl) {
        return; // Handled by CommandPaletteInput textarea auto-bullet logic
      }

      e.preventDefault();

      if (!activeCommand) {
        handleOptionSelect(highlightedIndex);
        return;
      }

      if (currentArg?.type === "text" || currentArg?.type === "markdown") {
        handleEnterForTextOrMarkdown(isCmdOrCtrl);
        return;
      }

      handleOptionSelect(highlightedIndex);
    }
  };

  const placeholderText = currentArg?.placeholder || "Type a command...";
  const emptyStateMessage = getEmptyStateMessage();
  const shouldHideDropdown =
    currentArg?.type === "text" || currentArg?.type === "markdown";

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
            transition={{
              duration: shouldReduceMotion ? 0 : 0.2,
              ease: "easeOut",
            }}
            className="bg-canvas/60 absolute inset-0 backdrop-blur-sm"
            onClick={handleClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -5 }}
            transition={{
              duration: shouldReduceMotion ? 0 : 0.3,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="bg-canvas-elevated relative flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <CommandPaletteInput
              inputRef={inputRef as React.RefObject<any>}
              inputText={inputText}
              placeholder={placeholderText}
              activeCommand={activeCommand}
              collectedArgs={collectedArgs}
              currentArgType={currentArg?.type}
              onChange={(value: string) => {
                setInputText(value);
                resetHighlight();
              }}
              onKeyDown={handleKeyDown}
            />

            {!shouldHideDropdown && (
              <CommandPaletteDropdown
                recommended={recommended}
                results={results}
                highlightedIndex={highlightedIndex}
                emptyStateMessage={emptyStateMessage}
                onHighlight={setHighlightedIndex}
                onSelect={handleOptionSelect}
              />
            )}

            {shouldHideDropdown && (
              <div className="bg-canvas/30 font-body text-text-tertiary flex items-center border-t border-white/5 px-4 py-3 text-sm">
                <span className="mr-2 opacity-70">Press</span>
                <kbd className="text-text-primary mr-2 rounded border border-white/10 bg-white/10 px-1.5 py-0.5 text-xs shadow-sm">
                  {currentArg?.type === "markdown" ? "⌘↵" : "Enter"}
                </kbd>
                <span className="opacity-70">to submit</span>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  if (typeof document === "undefined") return null;
  return createPortal(modal, document.body);
}
