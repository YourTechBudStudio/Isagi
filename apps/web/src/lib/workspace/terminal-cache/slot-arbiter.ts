export interface TerminalHostPlacement {
  readonly appendHost: () => void;
}

export interface TerminalSlotRegistration {
  readonly release: () => void;
}

/** Most-recent-live-slot arbitration for StrictMode probes and zen relocation overlap. */
export function createTerminalSlotArbiter(onEmpty: () => void) {
  let nextId = 0;
  const slots: Array<{ readonly id: number; readonly placement: TerminalHostPlacement }> = [];

  const activateLatest = () => {
    slots.at(-1)?.placement.appendHost();
  };

  return {
    register(placement: TerminalHostPlacement): TerminalSlotRegistration {
      const slot = { id: ++nextId, placement };
      slots.push(slot);
      activateLatest();
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          const index = slots.findIndex((candidate) => candidate.id === slot.id);
          if (index < 0) return;
          const wasActive = index === slots.length - 1;
          slots.splice(index, 1);
          if (!wasActive) return;
          if (slots.length > 0) activateLatest();
          else onEmpty();
        },
      };
    },
    get size() {
      return slots.length;
    },
  };
}
