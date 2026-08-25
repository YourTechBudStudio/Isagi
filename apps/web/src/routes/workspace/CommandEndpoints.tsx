import { Link2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { CommandSummary } from '@isagi/contracts';

import { LiveAnnouncement } from '../../components/LiveAnnouncement.js';
import { workbenchCopy } from '../../copy/index.js';
import { useSurfaceCopy } from '../../hooks/useSurfaceCopy.js';
import { uiTransition } from '../../lib/motion.js';
import type { RuntimeLocality } from '../../lib/runtime/locality.js';
import {
  commandBadgeId,
  commandEndpointsPresentation,
  commandPortsSignature,
  isPathlessCommandPort,
  type CommandEndpointsSummary,
} from '../../lib/workspace/command-ports.js';
import { CommandUrlBadge } from './CommandUrlBadge.js';
import { ResolvedPortBadge } from './ResolvedPortBadge.js';

/**
 * How long a confirmed copy stays readable before the popover dismisses itself.
 *
 * The popover is a lookup — you came for a URL, you got it, it goes away — but
 * dismissing instantly would leave ADR 0004's in-badge confirmation nowhere to
 * render. A failed copy does not dismiss at all: closing over a failure would
 * recreate exactly the silent-clipboard behavior this replaces.
 */
const COPY_DISMISS_DELAY_MS = 700;

/**
 * The command drawer's endpoints affordance: a toggle in the detail header and
 * the popover it opens.
 *
 * It is closed by default and floats over the log rather than expanding above it,
 * because the status strip is the primary endpoint surface — it already carries
 * the resolved port and the label without any interaction. The drawer is where
 * the user goes to read logs, so the endpoints panel is a genuine fallback and
 * takes no space from the thing they came for.
 *
 * The toggle changes tone rather than hiding when it is carrying something the
 * strip cannot show. When the runtime is non-local, or `ports` is `null`, the
 * strip renders no URL badges at all and this popover is the *only* channel — a
 * quiet closed toggle there would hide the one thing that needed to be seen.
 */
export function CommandEndpoints({
  commandName,
  ports,
  locality,
}: {
  readonly commandName: string;
  readonly ports: CommandSummary['ports'];
  readonly locality: RuntimeLocality;
}) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLSpanElement>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissOwed = useRef(false);
  const panelId = useId();

  const presentation = commandEndpointsPresentation(ports, locality);
  const signature = commandPortsSignature(ports);

  // A dismissal is owed only to a copy started during *this* opening, and only
  // until something supersedes it: a manual close, a reopen, a change to the
  // command's facts, unmount, or a fresh copy attempt. `dismissOwed` and the
  // timer are retired together, so there is one thing to reason about rather
  // than two — a pending timer and a claim that outlived the panel it belonged
  // to. The attempt case has to be handled at the click, not at the settlement:
  // a second `writeText` can stay pending past the remaining delay, and waiting
  // for it would let the first copy's timer close the panel out from under it.
  const cancelDismiss = useCallback(() => {
    dismissOwed.current = false;
    if (dismissTimer.current !== null) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  }, []);

  // Close, and return focus to the toggle only when focus is still inside the
  // popover. On an outside click focus is going where the user just clicked;
  // dragging it back to the toggle would be taking it from them.
  const close = useCallback(() => {
    cancelDismiss();
    setOpen(false);
    const container = containerRef.current;
    if (container && document.activeElement && container.contains(document.activeElement)) {
      toggleRef.current?.focus();
    }
  }, [cancelDismiss]);

  // One controller for the whole popover, so a slow write on one URL cannot
  // settle after a newer one and announce or dismiss over it.
  const { announcement, copyState, startCopy } = useSurfaceCopy({
    onAttempt: () => {
      cancelDismiss();
      dismissOwed.current = true;
    },
    onCopied: () => {
      if (!dismissOwed.current) {
        return;
      }
      dismissTimer.current = setTimeout(close, COPY_DISMISS_DELAY_MS);
    },
  });

  // One rule for state that moves underneath an open popover: any change to the
  // command's resolved facts, or to which command is selected, dismisses it. A
  // command that stops drops to `[]` and loses its toggle entirely, so the
  // popover must never outlive its trigger; and a refetch that reports `null`
  // must not silently re-label a panel the reader is mid-way through.
  useEffect(() => {
    cancelDismiss();
    setOpen(false);
  }, [signature, commandName, cancelDismiss]);

  useEffect(() => cancelDismiss, [cancelDismiss]);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Escape is listened for in the capture phase and consumed, so the drawer's
    // own window-level Escape handler never sees it. Dismissal belongs to the
    // topmost open surface, and while this popover is open that is this popover.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.stopPropagation();
      close();
    };
    // A click inside the drawer but outside this popover dismisses only the
    // popover; the drawer's own handler already ignores clicks within itself.
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  if (!presentation) {
    return null;
  }

  const { summary, ports: resolved, copyable, withheld, tone } = presentation;

  return (
    <span ref={containerRef} className="relative flex items-center">
      <button
        ref={toggleRef}
        type="button"
        onClick={() => {
          if (open) {
            close();
            return;
          }
          cancelDismiss();
          setOpen(true);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? workbenchCopy.commandEndpointsHide : workbenchCopy.commandEndpointsShow}
        className={`flex h-6 items-center gap-1.5 rounded-md border px-1.5 font-mono text-[10px] transition-colors duration-micro ease-expo ${
          tone === 'attention'
            ? 'border-amber/32 bg-amber/10 text-amber hover:border-amber/55'
            : 'border-cyan/26 bg-cyan/10 text-cyan hover:border-cyan/48'
        }`}
      >
        <Link2 size={10} aria-hidden />
        <span className="opacity-75">{summaryLabel(summary)}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            id={panelId}
            role="group"
            aria-label={workbenchCopy.commandEndpointsLabel}
            initial={{ opacity: 0, y: -6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.985 }}
            transition={uiTransition}
            className="absolute top-full right-0 z-20 mt-1.5 w-max min-w-84 max-w-[min(34rem,70vw)] rounded-xl border border-line/26 bg-canvas/96 p-3 shadow-soft backdrop-blur-md"
          >
            <p className="mb-2 font-mono text-[9px] tracking-widest text-fg-subtle uppercase opacity-60">
              {workbenchCopy.commandEndpointsLabel}
            </p>

            {summary.kind === 'unknown' ? (
              <p className="text-[12.5px] leading-relaxed text-fg-subtle">
                {workbenchCopy.commandPortsUnavailable}
              </p>
            ) : (
              <>
                {resolved.map((entry) => (
                  <div key={entry.port} className="pt-0.5 pb-1.5">
                    <div className="flex items-center gap-2">
                      <ResolvedPortBadge port={entry.port} />
                      {entry.envVar && (
                        <span className="font-mono text-[10px] text-fg-subtle opacity-85">
                          ${entry.envVar}
                        </span>
                      )}
                      {isPathlessCommandPort(entry) && (
                        <span className="font-mono text-[11px] text-fg-subtle opacity-70">
                          {workbenchCopy.commandPortNoPaths}
                        </span>
                      )}
                    </div>
                    {entry.urls.length > 0 && (
                      <div className="mt-0.5 ml-2 border-l border-line/22 pl-3.5">
                        {entry.urls.map((url) => {
                          // Labels are unique within a port; paths are not, so
                          // two rows can compose the same URL. The identity that
                          // keys this row is the identity its copy runs under.
                          const badgeId = commandBadgeId(entry.port, url.label);
                          return (
                            <div key={badgeId} className="flex min-w-0 items-baseline gap-2">
                              <span className="w-12 flex-none font-mono text-[10.5px] text-fg-subtle">
                                {url.label}
                              </span>
                              {copyable ? (
                                <CommandUrlBadge
                                  port={entry.port}
                                  label={url.label}
                                  url={url.url}
                                  presentation="url"
                                  state={copyState(badgeId)}
                                  onCopy={() => startCopy(badgeId, url.url)}
                                />
                              ) : (
                                // Not local: the declared path is a host-independent
                                // fact and stays, but the composed localhost URL
                                // would name this machine rather than the one running
                                // the command, so it is neither shown nor copyable.
                                <span className="min-w-0 font-mono text-[11px] wrap-anywhere text-fg-subtle opacity-75">
                                  {url.path}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
                {withheld && (
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-subtle">
                    {workbenchCopy.commandEndpointsRemoteRuntime}
                  </p>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Outside the popover on purpose: a confirmed copy dismisses the popover,
          and a live region living inside it would be announcing against its own
          teardown. */}
      <LiveAnnouncement announcement={announcement} />
    </span>
  );
}

function summaryLabel(summary: CommandEndpointsSummary): string {
  switch (summary.kind) {
    case 'urls':
      return workbenchCopy.commandEndpointsUrlCount(summary.count);
    case 'ports':
      return workbenchCopy.commandEndpointsPortCount(summary.count);
    case 'ports_without_urls':
      return workbenchCopy.commandEndpointsPortsWithoutUrls(summary.count);
    case 'unknown':
      return workbenchCopy.commandEndpointsUnknown;
  }
}
