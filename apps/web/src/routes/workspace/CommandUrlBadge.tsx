import type { ReactNode } from 'react';

import { workbenchCopy } from '../../copy/index.js';
import type { ClipboardCopyState } from '../../hooks/clipboard-copy.js';

/**
 * `compact` is the status-strip badge — port-anchored, showing `:5173 app`.
 * `url` is the drawer row, where the complete URL is the visible content.
 */
export type CommandUrlBadgePresentation = 'compact' | 'url';

/**
 * One copyable URL, in the two places a URL appears. Both presentations render
 * the same states from the same props, so the confirmation and failure
 * presentation exists once (ADR 0004: feedback belongs at the interaction site,
 * and a clipboard failure is never swallowed). The behavior behind it —
 * writing, ordering, announcing — belongs to the surface.
 *
 * **Layout stability is the load-bearing detail.** Every string a state can show
 * participates in layout from first paint and a state change toggles visibility
 * only. Without that, clicking a badge whose `copied` text is wider than its
 * label would shove its neighbours — and in the strip, shift the scroll position
 * out from under the pointer that just clicked.
 */
export function CommandUrlBadge({
  port,
  label,
  url,
  presentation,
  state,
  onCopy,
}: {
  readonly port: number;
  readonly label: string;
  readonly url: string;
  readonly presentation: CommandUrlBadgePresentation;
  /**
   * Handed down by the surface rather than held here.
   *
   * One clipboard, one current copy: ordering across badges can only be decided
   * where all of them are visible, so the surface owns the controller and this
   * renders what it is told. See `useSurfaceCopy`.
   */
  readonly state: ClipboardCopyState;
  /** Bound by the surface, which holds this badge's identity alongside its URL. */
  readonly onCopy: () => void;
}) {
  const title = workbenchCopy.commandUrlCopyTitle(url);

  if (presentation === 'compact') {
    return (
      <button
        type="button"
        onClick={onCopy}
        title={title}
        aria-label={title}
        className={`grid flex-none items-center rounded-md border px-1.5 py-px font-mono text-[10px] transition-colors duration-micro ease-expo ${
          state === 'failed'
            ? 'border-error/24 bg-error/10 text-error'
            : 'border-cyan/28 bg-cyan/10 text-cyan hover:border-cyan/45'
        }`}
      >
        <Stacked visible={state === 'idle'}>
          <span className="text-cyan/60">:{port}</span> {label}
        </Stacked>
        <Stacked visible={state === 'copied'}>{workbenchCopy.commandUrlCopied}</Stacked>
        <Stacked visible={state === 'failed'}>{workbenchCopy.commandUrlCopyFailed}</Stacked>
      </button>
    );
  }

  // The `url` presentation keeps the complete URL visible in every state — that
  // visibility *is* the acceptance criterion, so feedback may not replace it.
  // The marker sits in a trailing slot that exists from first paint and is sized
  // to the wider of the two markers, so nothing is appended at settlement time
  // and a long URL's wrap point never moves.
  return (
    <button
      type="button"
      onClick={onCopy}
      title={title}
      aria-label={title}
      className={`-mx-1.5 inline-flex max-w-full items-baseline gap-1.5 rounded-md px-1.5 py-px text-left font-mono text-[11.5px] transition-colors duration-micro ease-expo ${
        state === 'failed' ? 'text-error hover:bg-error/10' : 'text-cyan hover:bg-cyan/10'
      }`}
    >
      <span className="wrap-anywhere">{url}</span>
      <span className="grid flex-none text-[10px]">
        <Stacked visible={state === 'copied'}>· {workbenchCopy.commandUrlCopied}</Stacked>
        <Stacked visible={state === 'failed'}>· {workbenchCopy.commandUrlCopyFailed}</Stacked>
      </span>
    </button>
  );
}

/**
 * One cell of the stack. Every sibling occupies the same grid cell, so the
 * container's size is the widest of them for its whole life and `invisible`
 * hides a string without removing it from layout.
 */
function Stacked({
  visible,
  children,
}: {
  readonly visible: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={`col-start-1 row-start-1 whitespace-nowrap ${visible ? '' : 'invisible'}`}
      aria-hidden={visible ? undefined : true}
    >
      {children}
    </span>
  );
}
