import type { TerminalPaletteEntry } from '@isagi/contracts';

/**
 * The runtime is a node-pty program's terminal of record for queries.
 *
 * Programs ask their terminal about itself at startup (device attributes, default colours) and
 * often cache the answer for their whole life. If the answer depended on whether a pane happened to
 * be attached when the question was asked, a program launched with no pane (a workflow-spawned agent)
 * would see a different terminal from one launched with a pane. So the runtime answers every query
 * whose answer doesn't depend on screen state, attached or not, with the bytes xterm.js 6 (the
 * version `apps/web` renders with) would send, and removes it from the output stream.
 *
 * Two kinds of query are recognised:
 *
 * - **Identity queries** describe the terminal itself. They are always answered here and removed from
 *   both the live output and the log.
 * - **State queries** (cursor position) depend on screen state the runtime doesn't model. While an
 *   interactive pane is attached they go to it live and it answers; otherwise the runtime answers with
 *   a fixed `1;1` fallback so the program doesn't stall. They are always removed from the log.
 *
 * The log therefore never holds a query, so replaying it into a newly attached terminal can't make that
 * terminal answer a stale question. Everything else, including queries this module doesn't recognise
 * (`CSI 18t`, which xterm.js 6 leaves unanswered, kitty keyboard `CSI ?u`, DECRQM, OSC 4, ...), passes
 * through unchanged.
 *
 * A removed query leaves `ESC \` (ST) in its place. A query's leading ESC also acts on whatever
 * control sequence came before it: in xterm.js 6 an ESC from any parser state ends an unfinished OSC
 * or DCS string and aborts an unfinished CSI or escape sequence (`EscapeSequenceParser.ts`). Dropping the
 * query outright would drop that ESC too, so `ESC ] 0 ; title ESC [ c text` would leave `text` inside the
 * title. `ESC \` has exactly the same effect on the preceding sequence, and its own ESC dispatch (`\`)
 * has no handler, so it's a no-op that returns the parser to ground. This holds in every state, so the
 * filter needs no parser-state tracking.
 *
 * Every recognised query is a fixed byte string, so recognition is a literal match. A chunk may end
 * part-way through one; only such a trailing partial prefix is held back until the next chunk (at most
 * a few bytes), and anything that can't become a recognised query is released at once.
 *
 * This module is pure and synchronous: it runs inside node-pty's data callback, where no Effect may run.
 */

/** The part of the filter a PTY backend drives: every output chunk in, then `flush` at exit. */
export interface TerminalQueryStream {
  /**
   * Filters one output chunk. `replies` are written back to the PTY, in query order; `live` goes to
   * the attached terminal and `log` to the process log.
   */
  readonly push: (chunk: string) => TerminalQueryOutput;
  /** Releases any held partial prefix as plain output (for both live and log); it isn't a query. */
  readonly flush: () => string;
}

export interface TerminalQueryFilter extends TerminalQueryStream {
  /** True while an interactive attachment exists: state queries then go to it instead of the fallback. */
  readonly setStateQueryForwarding: (forward: boolean) => void;
}

export interface TerminalQueryOutput {
  readonly replies: readonly string[];
  readonly live: string;
  readonly log: string;
}

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;
/** What a removed query leaves behind; see the module comment. */
const removedQuery = ST;

interface RecognisedQuery {
  readonly query: string;
  readonly kind: 'identity' | 'state';
  /** The runtime's reply: always for identity queries, only without forwarding for state queries. */
  readonly reply: string;
}

function recognisedQueries(palette: TerminalPaletteEntry): readonly RecognisedQuery[] {
  // DA1. xterm.js 6 `InputHandler.sendDeviceAttributesPrimary` (src/common/InputHandler.ts) replies
  // `CSI ?1;2c` for its default `termName` 'xterm' and stays silent for a non-zero parameter.
  const da1 = `${ESC}[?1;2c`;
  // DA2. `sendDeviceAttributesSecondary` replies `CSI >0;276;0c` for 'xterm', silent for a non-zero parameter.
  const da2 = `${ESC}[>0;276;0c`;
  // DSR 5. `deviceStatus` case 5 replies `CSI 0n`.
  const status = `${ESC}[0n`;
  // OSC 10/11 `?`. `CoreBrowserTerminal` answers a colour report with
  // `OSC <id>;${toRgbString(color)} ST`: 16-bit channels (each 8-bit hex byte doubled) and always
  // terminated by `ESC \`, whichever terminator the query used.
  const foreground = `${ESC}]10;${xtermRgb(palette.foreground)}${ST}`;
  const background = `${ESC}]11;${xtermRgb(palette.background)}${ST}`;
  // CPR. `deviceStatus` / `deviceStatusPrivate` case 6 reply `CSI y;xR` / `CSI ?y;xR` from the real
  // cursor; without a pane the runtime has no screen, so it reports the home position.
  const cursor = `${ESC}[1;1R`;
  const cursorPrivate = `${ESC}[?1;1R`;
  return [
    { query: `${ESC}[c`, kind: 'identity', reply: da1 },
    { query: `${ESC}[0c`, kind: 'identity', reply: da1 },
    { query: `${ESC}[>c`, kind: 'identity', reply: da2 },
    { query: `${ESC}[>0c`, kind: 'identity', reply: da2 },
    { query: `${ESC}[5n`, kind: 'identity', reply: status },
    { query: `${ESC}]10;?${BEL}`, kind: 'identity', reply: foreground },
    { query: `${ESC}]10;?${ST}`, kind: 'identity', reply: foreground },
    { query: `${ESC}]11;?${BEL}`, kind: 'identity', reply: background },
    { query: `${ESC}]11;?${ST}`, kind: 'identity', reply: background },
    { query: `${ESC}[6n`, kind: 'state', reply: cursor },
    { query: `${ESC}[?6n`, kind: 'state', reply: cursorPrivate },
  ];
}

/** `#rrggbb` as xterm's `rgb:rrrr/gggg/bbbb` colour report. */
function xtermRgb(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`Terminal palette colour ${hex} is not #rrggbb.`);
  const [, red, green, blue] = match.map((part) => part.toLowerCase());
  return `rgb:${red}${red}/${green}${green}/${blue}${blue}`;
}

/** A filter for one process, answering colour queries from its theme's palette entry. */
export function createTerminalQueryFilter(palette: TerminalPaletteEntry): TerminalQueryFilter {
  const queries = recognisedQueries(palette);
  let forwardStateQueries = false;
  let held = '';

  const push = (chunk: string): TerminalQueryOutput => {
    const data = held + chunk;
    held = '';
    const replies: string[] = [];
    let live = '';
    let log = '';
    let emitted = 0;
    let at = data.indexOf(ESC);
    while (at !== -1) {
      const match = matchAt(queries, data, at);
      if (match === 'partial') {
        held = data.slice(at);
        break;
      }
      if (match === null) {
        at = data.indexOf(ESC, at + 1);
        continue;
      }
      const before = data.slice(emitted, at);
      log += before + removedQuery;
      if (match.kind === 'state' && forwardStateQueries) {
        live += before + match.query;
      } else {
        live += before + removedQuery;
        replies.push(match.reply);
      }
      emitted = at + match.query.length;
      at = data.indexOf(ESC, emitted);
    }
    const rest = data.slice(emitted, data.length - held.length);
    return { replies, live: live + rest, log: log + rest };
  };

  return {
    push,
    flush: () => {
      const released = held;
      held = '';
      return released;
    },
    setStateQueryForwarding: (forward) => {
      forwardStateQueries = forward;
    },
  };
}

/**
 * The query starting at `at`, `'partial'` if the data ends while it could still become one, or null.
 * No recognised query is a prefix of another, so at most one can match.
 */
function matchAt(
  queries: readonly RecognisedQuery[],
  data: string,
  at: number,
): RecognisedQuery | 'partial' | null {
  const remaining = data.length - at;
  let partial = false;
  for (const candidate of queries) {
    if (data.startsWith(candidate.query, at)) return candidate;
    if (remaining < candidate.query.length && candidate.query.startsWith(data.slice(at))) {
      partial = true;
    }
  }
  return partial ? 'partial' : null;
}
