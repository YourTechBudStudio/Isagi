/**
 * Chords are written as TanStack Hotkeys-style strings (`'Mod+K'`, `'Mod+.'`): modifiers, then the
 * key, joined by `+`. `Mod` is the platform's command modifier: Meta on macOS, Control elsewhere.
 */
export type Chord = `${'Mod+' | ''}${'Shift+' | ''}${'Alt+' | ''}${string}`;

export interface ParsedChord {
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** The key, lowercased, compared with `KeyboardEvent.key` lowercased. */
  readonly key: string;
}

export type ChordEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

export function parseChord(chord: Chord): ParsedChord {
  const parts = chord.split('+');
  // `Mod++` would name the plus key; no chord does today, so it is simply rejected.
  const key = parts.pop();
  if (key === undefined || key === '') throw new Error(`Shortcut chord has no key: ${chord}`);
  const modifiers = new Set(parts);
  for (const modifier of modifiers) {
    if (modifier !== 'Mod' && modifier !== 'Shift' && modifier !== 'Alt') {
      throw new Error(`Unknown modifier "${modifier}" in shortcut chord ${chord}`);
    }
  }
  return {
    mod: modifiers.has('Mod'),
    shift: modifiers.has('Shift'),
    alt: modifiers.has('Alt'),
    key: key.toLowerCase(),
  };
}

/**
 * Whether `event` is exactly `chord`. Modifiers are matched exactly, so `Mod+K` is not
 * `Mod+Shift+K`: a priority chord must not take a neighbouring binding (VS Code's Ctrl+Shift+K)
 * from the surface that owns it. Shift is only compared for letter keys; for punctuation the
 * layout decides whether Shift is needed to type the key at all, and `event.key` already says
 * which character it is.
 */
export function matchesChord(chord: ParsedChord, event: ChordEvent, isMac: boolean): boolean {
  if (event.key.toLowerCase() !== chord.key) return false;
  const command = isMac ? event.metaKey : event.ctrlKey;
  const other = isMac ? event.ctrlKey : event.metaKey;
  if (command !== chord.mod || other) return false;
  if (event.altKey !== chord.alt) return false;
  if (/^[a-z]$/u.test(chord.key) && event.shiftKey !== chord.shift) return false;
  return true;
}
