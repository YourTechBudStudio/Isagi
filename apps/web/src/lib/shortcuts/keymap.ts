import type { Chord } from './chord.js';
import { isEditableEventTarget } from './editable.js';

/**
 * A keymap entry: the chord, which window listener sees it, and the key-ownership rules that decide
 * whether the app takes it at all. What the shortcut *does* is not here; the component that owns the
 * command binds it by id (`useShortcut`), so the keymap stays a table of chords → commands (ADR 0003).
 *
 * - `phase: 'bubble'` yields to everything inside the page: a surface that consumes the key (xterm
 *   sending ^N to the PTY) keeps it.
 * - `phase: 'capture'` sees the key before the page does, but still only `preventDefault`s it.
 * - `priority: true` (capture only) also stops the event, so no focused surface (terminal, editor,
 *   text input) ever sees the key, and is the only kind of entry embedded same-origin documents
 *   such as the editor frame forward (`attachShortcutSource`).
 */
export type ShortcutEntry =
  | {
      readonly chord: Chord;
      readonly phase: 'bubble';
      readonly when?: (event: KeyboardEvent) => boolean;
    }
  | {
      readonly chord: Chord;
      readonly phase: 'capture';
      readonly priority?: true;
      readonly when?: (event: KeyboardEvent) => boolean;
    };

export type Keymap = Readonly<Record<string, ShortcutEntry>>;

/**
 * Isagi's app shortcuts. Only the palette takes priority over focused surfaces: it is how a user
 * gets anywhere from anywhere. The rest yield, because their chords belong to shells and editors
 * too (^N, ^W), and Mod+W deletes a pane that may hold a live session.
 */
export const appKeymap = {
  'toggle-palette': { chord: 'Mod+K', phase: 'capture', priority: true },
  'add-project': { chord: 'Mod+N', phase: 'bubble' },
  'toggle-zen': { chord: 'Mod+.', phase: 'bubble' },
  // Capture so it is decided before page handlers run, but it yields to anything already claimed
  // and to editable targets, which keeps shell ^W (xterm's helper textarea is one) and text editing.
  'delete-active-pane': {
    chord: 'Mod+W',
    phase: 'capture',
    when: (event) => !event.defaultPrevented && !isEditableEventTarget(event.target),
  },
} as const satisfies Keymap;

export type AppShortcutId = keyof typeof appKeymap;
