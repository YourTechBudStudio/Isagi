import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { CommandPaletteDropdown } from "@/components/command-palette/CommandPaletteDropdown";
import { CommandPaletteInput } from "@/components/command-palette/CommandPaletteInput";
import {
  type CommandId,
  createCommandController,
  getCommand,
} from "@/lib/commands/commands";
import {
  type CommandSearchResult,
  type EntitySearchResult,
  searchEntities,
} from "@/lib/commands/searchEntities";
import type {
  CommandController,
  CommandEffect,
  CommandFlowValues,
  CommandMetadata,
  CommandResolvedValue,
  CommandStartResult,
  CommandStep,
  HistoryFrame,
} from "@/lib/commands/types";
import {
  useCommandPaletteActions,
  useCommandPaletteIsOpen,
  useCommandPaletteLaunchRequest,
} from "@/stores/commandPalette.selectors";

function getEmptyStateMessage(): string {
  const messages = [
    "404: Imagination not found.",
    "Nothing matches. Suspicious. I will allow it.",
    "I searched my entire context window. Nothing.",
    "Cache miss. And by cache, I mean reality.",
    "That does not exist. Should I hallucinate it for you?",
  ];
  return messages[Math.floor(Math.random() * messages.length)];
}

type FlowSessionState = {
  readonly metadata: CommandMetadata;
  readonly controller: CommandController;
  readonly currentStep: CommandStep;
  readonly history: ReadonlyArray<HistoryFrame>;
  readonly values: CommandFlowValues;
  readonly draft: string;
  readonly error: string | null;
  readonly isLoading: boolean;
};

function buildValuesFromHistory(
  history: ReadonlyArray<HistoryFrame>,
): Record<string, CommandResolvedValue> {
  return Object.fromEntries(
    history.map(frame => [frame.step.id, frame.value]),
  ) as Record<string, CommandResolvedValue>;
}

function getToastOptions(effect: CommandEffect) {
  return {
    description: effect.description,
    action: effect.action,
    cancel: effect.cancel,
  };
}

export function CommandPalette() {
  const isOpen = useCommandPaletteIsOpen();
  const launchRequest = useCommandPaletteLaunchRequest();
  const { clearLaunchRequest, close, launchCommand, open } =
    useCommandPaletteActions();
  const shouldReduceMotion = useReducedMotion();

  const [searchText, setSearchText] = useState("");
  const [flowSession, setFlowSession] = useState<FlowSessionState | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const operationTokenRef = useRef(0);

  const currentStep = flowSession?.currentStep ?? null;
  const currentInputText = flowSession?.draft ?? searchText;

  const searchType =
    currentStep?.kind === "entity-search" ? currentStep.entityType : null;
  const { recommended, results } = searchEntities(
    searchType,
    currentInputText,
    currentStep?.kind === "entity-search" ? currentStep.contextId : undefined,
  );
  const allVisibleOptions = [...recommended, ...results];

  const resetHighlight = (): void => {
    setHighlightedIndex(0);
  };

  const applyEffect = (effect?: CommandEffect): void => {
    if (!effect) {
      return;
    }

    const options = getToastOptions(effect);

    if (effect.variant === "success") {
      toast.success(effect.message, options);
      return;
    }

    if (effect.variant === "error") {
      toast.error(effect.message, options);
      return;
    }

    toast(effect.message, options);
  };

  const resetLocalState = (): void => {
    setSearchText("");
    setFlowSession(null);
    setHighlightedIndex(0);
  };

  const handleClose = (): void => {
    operationTokenRef.current += 1;
    close();

    window.setTimeout(() => {
      resetLocalState();
    }, 200);
  };

  const beginCommandFlow = async (commandId: CommandId): Promise<void> => {
    const metadata = getCommand(commandId);
    const controller = createCommandController(metadata.id);
    const operationToken = operationTokenRef.current + 1;
    operationTokenRef.current = operationToken;

    setSearchText("");
    setFlowSession(null);
    resetHighlight();

    const startResult = await controller.start();

    if (operationToken !== operationTokenRef.current) {
      return;
    }

    if (startResult.type === "step") {
      setFlowSession({
        metadata,
        controller,
        currentStep: startResult.step,
        history: [],
        values: {},
        draft: startResult.step.initialDraft ?? "",
        error: null,
        isLoading: false,
      });
      return;
    }

    handleClose();
    applyEffect(startResult.effect);
  };

  const submitFlowStep = async (
    selected?: EntitySearchResult,
  ): Promise<void> => {
    if (!flowSession || flowSession.isLoading) {
      return;
    }

    const operationToken = operationTokenRef.current + 1;
    operationTokenRef.current = operationToken;

    const sessionSnapshot = flowSession;
    setFlowSession({
      ...sessionSnapshot,
      error: null,
      isLoading: true,
    });

    const result = await sessionSnapshot.controller.submit({
      step: sessionSnapshot.currentStep,
      draft: sessionSnapshot.draft,
      history: sessionSnapshot.history,
      values: sessionSnapshot.values,
      selected,
    });

    if (operationToken !== operationTokenRef.current) {
      return;
    }

    if (result.type === "stay") {
      setFlowSession({
        ...sessionSnapshot,
        draft: result.draft ?? sessionSnapshot.draft,
        error: result.error ?? null,
        isLoading: false,
      });
      return;
    }

    if (result.type === "next") {
      const nextHistory = [...sessionSnapshot.history, result.frame];
      setFlowSession({
        ...sessionSnapshot,
        currentStep: result.step,
        history: nextHistory,
        values: {
          ...sessionSnapshot.values,
          [result.frame.step.id]: result.frame.value,
        },
        draft: result.step.initialDraft ?? "",
        error: null,
        isLoading: false,
      });
      resetHighlight();
      return;
    }

    if (result.type === "complete") {
      if (result.frame) {
        const nextHistory = [...sessionSnapshot.history, result.frame];
        setFlowSession({
          ...sessionSnapshot,
          history: nextHistory,
          values: {
            ...sessionSnapshot.values,
            [result.frame.step.id]: result.frame.value,
          },
          isLoading: false,
        });
      }

      handleClose();
      applyEffect(result.effect);
      return;
    }

    handleClose();
    applyEffect(result.effect);
  };

  const handleSelectCommand = (selected: CommandSearchResult): void => {
    void beginCommandFlow(selected.commandId);
  };

  const handleSelectOption = (index: number): void => {
    const selected = allVisibleOptions[index];
    if (!selected) {
      return;
    }

    if (!flowSession) {
      if (selected.kind !== "command") {
        return;
      }

      handleSelectCommand(selected);
      return;
    }

    if (
      flowSession.currentStep.kind !== "entity-search" ||
      selected.kind !== "entity"
    ) {
      return;
    }

    void submitFlowStep(selected);
  };

  const handleBackspaceNavigation = (): void => {
    if (!flowSession) {
      handleClose();
      return;
    }

    if (flowSession.isLoading) {
      return;
    }

    const previousFrame = flowSession.history[flowSession.history.length - 1];
    if (!previousFrame) {
      setFlowSession(null);
      resetHighlight();
      return;
    }

    const nextHistory = flowSession.history.slice(0, -1);
    setFlowSession({
      ...flowSession,
      currentStep: previousFrame.step,
      history: nextHistory,
      values: buildValuesFromHistory(nextHistory),
      draft: previousFrame.draft,
      error: null,
      isLoading: false,
    });
    resetHighlight();
  };

  // Keyboard shortcut listener for Cmd/Ctrl + K, Cmd/Ctrl + P, Ctrl + M.
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const isCmdK =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const isCmdP =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "p";
      const isCtrlM = event.ctrlKey && event.key.toLowerCase() === "m";

      if (isCmdK || isCmdP) {
        event.preventDefault();
        open();
      } else if (isCtrlM) {
        event.preventDefault();
        launchCommand("capture-spark");
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [launchCommand, open]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 50);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen, currentStep?.id]);

  useEffect(() => {
    if (!isOpen || !launchRequest) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const showEffect = (effect?: CommandEffect): void => {
        if (!effect) {
          return;
        }

        const options = getToastOptions(effect);

        if (effect.variant === "success") {
          toast.success(effect.message, options);
          return;
        }

        if (effect.variant === "error") {
          toast.error(effect.message, options);
          return;
        }

        toast(effect.message, options);
      };

      const closePalette = (): void => {
        operationTokenRef.current += 1;
        close();

        window.setTimeout(() => {
          setSearchText("");
          setFlowSession(null);
          setHighlightedIndex(0);
        }, 200);
      };

      clearLaunchRequest();

      const metadata = getCommand(launchRequest.commandId);
      const controller = createCommandController(metadata.id);
      const operationToken = operationTokenRef.current + 1;
      operationTokenRef.current = operationToken;

      setSearchText("");
      setFlowSession(null);
      setHighlightedIndex(0);

      void Promise.resolve(controller.start()).then(
        (startResult: CommandStartResult) => {
          if (operationToken !== operationTokenRef.current) {
            return;
          }

          if (startResult.type === "step") {
            setFlowSession({
              metadata,
              controller,
              currentStep: startResult.step,
              history: [],
              values: {},
              draft: startResult.step.initialDraft ?? "",
              error: null,
              isLoading: false,
            });
            return;
          }

          closePalette();
          showEffect(startResult.effect);
        },
      );
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [clearLaunchRequest, close, isOpen, launchRequest]);

  const handleInputChange = (value: string): void => {
    if (flowSession) {
      setFlowSession({
        ...flowSession,
        draft: value,
        error: null,
      });
    } else {
      setSearchText(value);
    }

    resetHighlight();
  };

  const handleHelperAction = (): void => {
    if (currentStep?.kind !== "file") {
      return;
    }

    toast("Folder picker is coming soon. Paste a server path for now.");
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void => {
    if (event.key === "Escape") {
      if (currentStep?.kind === "markdown" && currentInputText.trim()) {
        if (!window.confirm("Discard this spark?")) {
          event.preventDefault();
          return;
        }
      }

      event.preventDefault();
      handleClose();
      return;
    }

    if (event.key === "ArrowDown") {
      if (currentStep?.kind === "markdown") {
        return;
      }

      event.preventDefault();
      if (allVisibleOptions.length === 0) {
        return;
      }

      setHighlightedIndex(previousIndex =>
        Math.min(previousIndex + 1, allVisibleOptions.length - 1),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      if (currentStep?.kind === "markdown") {
        return;
      }

      event.preventDefault();
      if (allVisibleOptions.length === 0) {
        return;
      }

      setHighlightedIndex(previousIndex => Math.max(previousIndex - 1, 0));
      return;
    }

    if (event.key === "Backspace" && currentInputText === "") {
      event.preventDefault();
      handleBackspaceNavigation();
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    const isCmdOrCtrl = event.metaKey || event.ctrlKey;

    if (currentStep?.kind === "markdown" && !isCmdOrCtrl) {
      return;
    }

    event.preventDefault();

    if (!flowSession) {
      handleSelectOption(highlightedIndex);
      return;
    }

    if (currentStep?.kind === "entity-search") {
      handleSelectOption(highlightedIndex);
      return;
    }

    void submitFlowStep();
  };

  const placeholderText = currentStep?.placeholder || "Type a command...";
  const emptyStateMessage = getEmptyStateMessage();
  const shouldHideDropdown = currentStep
    ? currentStep.kind !== "entity-search"
    : false;
  const footerShortcutLabel =
    currentStep?.kind === "markdown"
      ? "⌘↵"
      : currentStep?.kind === "file"
        ? "Enter"
        : "Enter";
  const footerText = flowSession?.isLoading
    ? currentStep?.kind === "file"
      ? "Checking path..."
      : "Working on it..."
    : "to submit";

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
            onClick={event => event.stopPropagation()}
          >
            <CommandPaletteInput
              inputRef={inputRef}
              inputText={currentInputText}
              placeholder={placeholderText}
              commandLabel={flowSession?.metadata.label ?? null}
              history={flowSession?.history ?? []}
              currentStep={currentStep}
              error={flowSession?.error ?? null}
              isLoading={flowSession?.isLoading ?? false}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onHelperAction={handleHelperAction}
            />

            {!shouldHideDropdown && (
              <CommandPaletteDropdown
                recommended={recommended}
                results={results}
                highlightedIndex={highlightedIndex}
                emptyStateMessage={emptyStateMessage}
                onHighlight={setHighlightedIndex}
                onSelect={handleSelectOption}
              />
            )}

            {shouldHideDropdown && (
              <div className="bg-canvas/30 font-body text-text-tertiary flex items-center border-t border-white/5 px-4 py-3 text-sm">
                <span className="mr-2 opacity-70">Press</span>
                <kbd className="text-text-primary mr-2 rounded border border-white/10 bg-white/10 px-1.5 py-0.5 text-xs shadow-sm">
                  {footerShortcutLabel}
                </kbd>
                <span className="opacity-70">{footerText}</span>
              </div>
            )}

            {!shouldHideDropdown && flowSession?.isLoading && (
              <div className="bg-canvas/30 font-body text-text-tertiary border-t border-white/5 px-4 py-3 text-sm">
                Working on it...
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(modal, document.body);
}
