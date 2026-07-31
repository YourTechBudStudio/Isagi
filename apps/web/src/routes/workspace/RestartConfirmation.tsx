import { Popover } from '@base-ui/react/popover';
import type { ReactElement } from 'react';
import { useRef } from 'react';

import { updateCopy } from '../../copy/updates.js';

/**
 * What the runtime knew about agent activity when the user asked to restart.
 * `unknown` is deliberately distinct from a count of zero: zero proceeds
 * silently, unknown asks, because readiness could not be determined.
 */
export type RestartActivity =
  | { readonly kind: 'working'; readonly workingAgentCount: number }
  | { readonly kind: 'unknown' };

/**
 * The restart warning, anchored to the control that raised it. It rises from the
 * rail footer rather than taking the screen, so the work the user is being asked
 * about stays visible behind the question — the surface they are weighing is the
 * one they can still see.
 *
 * The snapshot is advisory (see the plan's settled decisions): it reports what
 * was true when the user asked, and confirming proceeds without re-checking.
 *
 * This popover is *controlled by the host*, and mounted for the whole ready
 * state rather than only when there is something to ask. The causality demands
 * it: pressing the trigger sends a restart request, the desktop reads agent
 * activity, and only then — one round trip later — does an activity arrive.
 * There is no click left to open with at that point, and a popover that mounted
 * on the activity and unmounted on the cancel could neither animate nor restore
 * focus. So the trigger's own toggle is ignored and `activity` alone decides.
 *
 * Focus contract, which the fixture spec pins: `Keep working` takes focus on
 * open, so Enter is always the safe answer; Escape cancels; closing by any route
 * returns focus to the trigger.
 */
export function RestartConfirmation({
  trigger,
  activity,
  version,
  onCancel,
  onProceed,
}: {
  /** The restart control. Base UI merges its trigger props onto this element. */
  trigger: ReactElement;
  /** `null` while the host is not asking — the popover stays closed. */
  activity: RestartActivity | null;
  version: string;
  onCancel: () => void;
  onProceed: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const working = activity?.kind === 'working';

  return (
    <Popover.Root
      modal
      open={activity !== null}
      onOpenChange={(open) => {
        // Opening is the host's decision, never the trigger's. Closing is the
        // user's, and every route to it — Escape, outside press, `Keep working`
        // — means the same thing: cancel.
        if (!open) onCancel();
      }}
    >
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={10} className="z-50 outline-none">
          <Popover.Popup
            initialFocus={cancelRef}
            data-restart-confirmation
            className="origin-(--transform-origin) w-[288px] rounded-md border border-line/30 bg-elevated/92 p-4 shadow-soft backdrop-blur-xl transition-[opacity,transform] duration-ui ease-expo outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
          >
            <Popover.Title className="text-[13px] font-semibold text-fg">
              {working
                ? updateCopy.confirm.workingTitle(activity.workingAgentCount)
                : updateCopy.confirm.unknownTitle}
            </Popover.Title>
            <Popover.Description className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">
              {working
                ? updateCopy.confirm.workingBody(activity.workingAgentCount, version)
                : updateCopy.confirm.unknownBody(version)}
            </Popover.Description>
            <div className="mt-4 flex gap-2">
              <Popover.Close
                ref={cancelRef}
                data-confirm-cancel
                className="flex-1 rounded-md border border-line/40 px-3 py-2 text-[12.5px] font-medium text-fg-muted transition-colors duration-micro ease-expo hover:border-line/60 hover:text-fg focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-line/60"
              >
                {updateCopy.confirm.cancel}
              </Popover.Close>
              {/* Amber, not red: closing the app to install is consequential and
                  reversible, not destruction.

                  Deliberately not a `Popover.Close`. Closing dispatches cancel,
                  so a proceed that also closed would send both the confirmation
                  and its cancellation. The host closes this popover by leaving
                  the ready state for `installing`. */}
              <button
                type="button"
                data-confirm-proceed
                onClick={onProceed}
                className="rounded-md border border-amber/38 bg-amber/12 px-3 py-2 text-[12.5px] font-medium text-fg transition-colors duration-micro ease-expo hover:border-amber/55 hover:bg-amber/18 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-amber/60"
              >
                {updateCopy.confirm.proceed}
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
