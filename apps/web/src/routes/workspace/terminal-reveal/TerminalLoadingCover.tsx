import { ptyCopy } from '../../../copy/index.js';

/**
 * The opaque cover a terminal wears while it rebuilds itself from replay.
 *
 * It is the same running state the command palette uses, moved onto a pane: the
 * `command-sweep` hairline along the top edge carries "this surface is working",
 * and a breathing working-dot beside a dry status line carries what it is
 * working on. Isagi already says "something of unknown length is in flight here"
 * exactly this way in the palette, the context menu, and the pane action
 * cluster; a cold terminal is the same fact on a different surface, so it says
 * it the same way. The sweep never fills — it claims activity, not progress,
 * which is all replay bytes can honestly support.
 *
 * The cover is a sibling overlay inside a positioned slot, never a wrapper
 * around the terminal — the cache owns the terminal's DOM host imperatively and
 * React must not sit between the two. It is fully opaque at every intermediate
 * state: parse-complete-but-unpainted looks identical to first-byte, because
 * replay progress says nothing about when xterm actually puts pixels down.
 *
 * It intercepts pointer events (a click must not land in a terminal the user
 * cannot see), holds no focus, and carries no accessible text of its own —
 * `TerminalRevealSlot` owns the one stable live region that announces the wait.
 */
export function TerminalLoadingCover({ reducedMotion }: { readonly reducedMotion: boolean }) {
  return (
    <div
      aria-hidden
      data-terminal-cover
      className="absolute inset-0 z-10 overflow-hidden bg-terminal-surface select-none"
    >
      <span className="command-sweep command-sweep-pinned-top" />
      <div className="grid h-full place-items-center px-4">
        {/* Mono at pane-chrome size rather than the palette's sans body: inside a
            terminal, status text that is not the terminal's own should still
            read as terminal chrome. */}
        <p className="flex items-center gap-2 font-mono text-[11.5px] text-fg-muted">
          <span
            className={`size-1.75 flex-none rounded-full bg-working ${
              reducedMotion ? '' : 'animate-breathe motion-reduce:animate-none'
            }`}
          />
          {ptyCopy.reconstructing}
        </p>
      </div>
    </div>
  );
}
