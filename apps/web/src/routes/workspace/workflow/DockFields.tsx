import { toneClass, type DockRow } from './dock.js';

/**
 * The inspector's label/value grid, and the tone it paints values in.
 *
 * Its own module rather than a private helper inside `WorkflowDock.tsx` because three surfaces now
 * render the same grid — the dock's four original columns, the Evidence tab's detail pane, and the
 * provenance block that appears in both — and the dock cannot export it to them without importing
 * them back. One grid means a provenance row and a recorded row line up, wrap and dim identically,
 * which is the whole reason they read as one surface.
 */
export function Fields({
  rows,
  onOpenTab,
}: {
  readonly rows: readonly DockRow[];
  readonly onOpenTab?: ((tab: string) => void) | undefined;
}) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] items-baseline gap-x-4 gap-y-1.5 font-mono text-[12px]">
      {rows.map((row, index) =>
        'gap' in row ? (
          <span key={index} aria-hidden className="col-span-2 h-1.5" />
        ) : (
          <div key={`${row.label}-${index}`} className="contents">
            <dt className="whitespace-nowrap text-fg-subtle">{row.label}</dt>
            <dd className={`m-0 wrap-break-word ${toneClass(row.tone)}`}>
              {row.dataTab && onOpenTab ? (
                <button
                  type="button"
                  onClick={() => onOpenTab(row.dataTab!)}
                  className="text-cyan underline decoration-dotted underline-offset-[3px] transition duration-micro ease-expo hover:text-fg"
                >
                  {row.value}
                </button>
              ) : (
                row.value
              )}
            </dd>
          </div>
        ),
      )}
    </dl>
  );
}
