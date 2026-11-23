import { matchesChord, parseChord, type ParsedChord } from './chord.js';
import type { Keymap, ShortcutEntry } from './keymap.js';

/** What a component binds to a keymap entry: the command to run, and whether it applies right now. */
export interface ShortcutBinding {
  /**
   * App state that decides whether the shortcut is the app's to take (the palette is open, there
   * is no active surface). When it says no, the key is left alone entirely: no `preventDefault`.
   */
  readonly enabled?: (event: KeyboardEvent) => boolean;
  /** Runs after the key was claimed; a binding that no-ops still claims it. */
  readonly run: (event: KeyboardEvent) => void;
}

/** The part of a `Window` the dispatcher listens on. */
export type ShortcutWindow = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export interface ShortcutDispatcher<Id extends string> {
  /** Bind `id`'s command. The most recent binding of an id is the one that runs. */
  readonly bind: (id: Id, binding: ShortcutBinding) => () => void;
  /** Dispatch every entry from this window, each in its own phase. */
  readonly install: (win: ShortcutWindow) => () => void;
  /**
   * Feed another same-origin document (the editor frame) into the dispatcher. Only priority
   * entries are dispatched from it, only from trusted (user-generated) events, so a script in that
   * document can neither trigger an app command nor reach the yielding shortcuts.
   */
  readonly attachSource: (win: ShortcutWindow) => () => void;
}

type Phase = ShortcutEntry['phase'];
type Source = 'host' | 'embedded';

export function createShortcutDispatcher<Id extends string>(options: {
  readonly keymap: Readonly<Record<Id, ShortcutEntry>>;
  readonly isMac: () => boolean;
}): ShortcutDispatcher<Id> {
  const entries: readonly { id: Id; entry: ShortcutEntry; chord: ParsedChord }[] = (
    Object.entries(options.keymap as Keymap) as [Id, ShortcutEntry][]
  ).map(([id, entry]) => ({ id, entry, chord: parseChord(entry.chord) }));
  const bindings = new Map<Id, ShortcutBinding[]>();

  const dispatch = (event: KeyboardEvent, phase: Phase, source: Source) => {
    if (source === 'embedded' && !event.isTrusted) return;
    const isMac = options.isMac();
    for (const { id, entry, chord } of entries) {
      if (entry.phase !== phase) continue;
      const priority = entry.phase === 'capture' && entry.priority === true;
      if (source === 'embedded' && !priority) continue;
      if (!matchesChord(chord, event, isMac)) continue;
      if (entry.when && !entry.when(event)) continue;
      const binding = bindings.get(id)?.at(-1);
      if (!binding || (binding.enabled && !binding.enabled(event))) continue;
      event.preventDefault();
      if (priority) event.stopPropagation();
      binding.run(event);
      return;
    }
  };

  const listen = (win: ShortcutWindow, phases: readonly Phase[], source: Source) => {
    const listeners = phases.map((phase) => {
      const listener = (event: Event) => dispatch(event as KeyboardEvent, phase, source);
      const capture = phase === 'capture';
      win.addEventListener('keydown', listener, capture);
      return () => win.removeEventListener('keydown', listener, capture);
    });
    return () => {
      for (const remove of listeners) remove();
    };
  };

  return {
    bind: (id, binding) => {
      const stack = bindings.get(id) ?? [];
      stack.push(binding);
      bindings.set(id, stack);
      return () => {
        const index = stack.lastIndexOf(binding);
        if (index !== -1) stack.splice(index, 1);
      };
    },
    install: (win) => listen(win, ['capture', 'bubble'], 'host'),
    attachSource: (win) => listen(win, ['capture'], 'embedded'),
  };
}
