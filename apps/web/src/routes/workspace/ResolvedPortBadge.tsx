/**
 * A resolved port, rendered as a fact.
 *
 * One visual rule holds across every endpoint surface: **a bordered pill is
 * interactive, borderless text is a fact.** Port-anchored URL badges read
 * `:5173 app` and are buttons; this token reads `:9229` and is not. Before the
 * rule they shared a shape, a colour, a border and a leading `:port`, differing
 * only by a trailing word — so the border now carries the affordance and this
 * token gives its up.
 *
 * Deliberately not a `<button>`, not focusable, and carrying no title: there is
 * nothing to copy and nothing to open.
 */
export function ResolvedPortBadge({ port }: { readonly port: number }) {
  return <span className="flex-none font-mono text-[10px] text-cyan/60">:{port}</span>;
}
