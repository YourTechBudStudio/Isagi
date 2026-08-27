import type { CommandPort, CommandSummary } from '@isagi/contracts';

import type { RuntimeLocality } from '../runtime/locality.js';

/**
 * How resolved-port facts become endpoint presentation, in one place.
 *
 * Three surfaces read these facts — the status strip, the command drawer, and
 * the palette subtitle — and each of them once had its own opinion about what
 * "no paths" and "not local" mean. Centralizing the rules is what keeps the
 * pathless fallback, the locality gate, and the degraded boundary from drifting
 * apart between them.
 */

/**
 * A resolved port with nothing to open. It is still a real port the process
 * received — an inspector, a database, a gRPC listener — so it is shown, just
 * without a URL affordance.
 */
export function isPathlessCommandPort(port: CommandPort): boolean {
  return port.urls.length === 0;
}

/** What the endpoints toggle counts, before the copy layer gives it words. */
export type CommandEndpointsSummary =
  | { readonly kind: 'urls'; readonly count: number }
  | { readonly kind: 'ports'; readonly count: number }
  | { readonly kind: 'ports_without_urls'; readonly count: number }
  | { readonly kind: 'unknown' };

export interface CommandEndpointsPresentation {
  readonly ports: readonly CommandPort[];
  readonly summary: CommandEndpointsSummary;
  /** URLs may be rendered as text and copied. False whenever the runtime is not local. */
  readonly copyable: boolean;
  /** URLs exist but are being withheld, which is the only thing the locality notice claims. */
  readonly withheld: boolean;
  /**
   * `attention` means the closed toggle is carrying something the user has not
   * seen. It matters because the status strip shows nothing in exactly these
   * states, so the drawer is the only channel left.
   */
  readonly tone: 'quiet' | 'attention';
}

/**
 * The endpoints view for one command, or `null` when there is nothing to offer
 * and no toggle should render at all.
 *
 * `null` ports and an empty array are deliberately different outcomes. An empty
 * array is authoritative — this incarnation declared no ports — and renders
 * nothing. A `null` is honest degradation for a running command whose resolution
 * is unknown, and has to stay visible; collapsing the two into silence would
 * destroy the distinction the nullable contract exists for.
 */
export function commandEndpointsPresentation(
  ports: CommandSummary['ports'],
  locality: RuntimeLocality,
): CommandEndpointsPresentation | null {
  if (ports === null) {
    return {
      ports: [],
      summary: { kind: 'unknown' },
      copyable: false,
      withheld: false,
      tone: 'attention',
    };
  }
  if (ports.length === 0) {
    return null;
  }

  const urlCount = ports.reduce((total, entry) => total + entry.urls.length, 0);

  if (urlCount === 0) {
    // An all-pathless set is identical under both localities: nothing is being
    // withheld, because there were never any URLs to withhold. Going amber here
    // would claim a loss the user has not suffered.
    return {
      ports,
      summary: { kind: 'ports', count: ports.length },
      copyable: false,
      withheld: false,
      tone: 'quiet',
    };
  }

  if (locality === 'non_local') {
    return {
      ports,
      summary: { kind: 'ports_without_urls', count: ports.length },
      copyable: false,
      withheld: true,
      tone: 'attention',
    };
  }

  return {
    ports,
    summary: { kind: 'urls', count: urlCount },
    copyable: true,
    withheld: false,
    tone: 'quiet',
  };
}

/** One badge on the status strip, in declaration order. */
export type CommandStripEndpoint =
  | { readonly kind: 'url'; readonly port: number; readonly label: string; readonly url: string }
  | { readonly kind: 'port'; readonly port: number };

/**
 * The strip's badges for one command.
 *
 * A non-local runtime hides URL badges but must not reinterpret a port that has
 * paths as pathless — that would present a withheld endpoint as one that never
 * had a URL, which is a different and untrue fact. So a pathful port contributes
 * nothing to the strip when not local, rather than falling back to a raw token.
 */
export function commandStripEndpoints(
  ports: CommandSummary['ports'],
  locality: RuntimeLocality,
): readonly CommandStripEndpoint[] {
  if (ports === null) {
    return [];
  }
  return ports.flatMap((entry): readonly CommandStripEndpoint[] => {
    if (isPathlessCommandPort(entry)) {
      return [{ kind: 'port', port: entry.port }];
    }
    if (locality !== 'local') {
      return [];
    }
    return entry.urls.map((url) => ({
      kind: 'url',
      port: entry.port,
      label: url.label,
      url: url.url,
    }));
  });
}

/**
 * The resolved ports the palette's compact `:{port}` subtitle may use.
 *
 * Only genuinely pathless entries qualify. A port with paths is represented by
 * its strip badges and its drawer row, and adding it here as a bare number would
 * be a third, less informative presentation of the same fact.
 */
export function pathlessCommandPortNumbers(ports: CommandSummary['ports']): readonly number[] {
  return (ports ?? []).filter(isPathlessCommandPort).map((entry) => entry.port);
}

/**
 * A stable signature of the resolved facts, used to notice that they changed.
 *
 * The endpoints popover is a lookup scoped to one incarnation's resolution. When
 * that resolution changes underneath an open popover — the command stops and
 * drops to `[]`, or a refetch reports `null` — the popover dismisses rather than
 * re-labelling itself around content the reader did not ask for.
 */
export function commandPortsSignature(ports: CommandSummary['ports']): string {
  if (ports === null) {
    return 'unknown';
  }
  return ports
    .map((entry) => `${entry.port}:${entry.urls.map((url) => url.url).join(',')}`)
    .join('|');
}

/**
 * A surface-local identity for one copyable badge, built from the tuple that
 * actually distinguishes it on that surface.
 *
 * The tuple is JSON-encoded rather than joined on a separator. Command names and
 * URL labels are free-form config strings — normalization rejects only
 * surrounding whitespace — so they may contain whatever delimiter we would pick,
 * and two different tuples can flatten to one string: command `a:5001` on port
 * `5002` with label `x` joins to the same `a:5001:5002:x` as command `a` on port
 * `5001` with label `5002:x`. Colliding badges would share React reconciliation
 * identity *and* copy state, putting one badge's confirmation inside another's,
 * against ADR 0004. JSON encoding escapes its own delimiters and keeps numbers
 * distinct from their digit strings, so distinct tuples stay distinct.
 */
export function commandBadgeId(...parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}
