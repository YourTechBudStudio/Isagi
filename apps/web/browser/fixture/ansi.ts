export const ANSI_FIXTURE_SEED = 0x15a61;
export const ANSI_CHUNK_BYTES = 64 * 1024;
export const MAX_ENCODED_INPUT_BYTES = 256 * 1024 * 1024;

export type AnsiRecipe = 'shell' | 'codex' | 'claude' | 'pi' | 'opencode';

/** Deterministic synthetic terminal data. No captured harness or user content belongs here. */
export function* generateAnsiFixture(recipe: AnsiRecipe, byteLength: number) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_ENCODED_INPUT_BYTES) {
    throw new RangeError(`fixture input ${byteLength} exceeds the 256 MiB safety ceiling`);
  }
  let emitted = 0;
  let line = ANSI_FIXTURE_SEED;
  const wrappers = recipeSequences(recipe);
  if (wrappers.prefix) {
    yield wrappers.prefix;
    emitted += wrappers.prefix.length;
  }
  while (emitted < Math.max(0, byteLength - wrappers.suffix.length)) {
    const text = `${recipe}:${String(line).padStart(8, '0')} deterministic terminal row\r\n`;
    const remaining = byteLength - wrappers.suffix.length - emitted;
    const chunkTarget = Math.min(ANSI_CHUNK_BYTES, remaining);
    let chunk = '';
    while (chunk.length < chunkTarget) {
      chunk += text.slice(0, Math.min(text.length, chunkTarget - chunk.length));
      line = (line * 1_664_525 + 1_013_904_223) >>> 0;
    }
    emitted += chunk.length;
    yield chunk;
  }
  if (wrappers.suffix) yield wrappers.suffix.slice(0, Math.max(0, byteLength - emitted));
}

/**
 * Stream framing for the *bulk* cold-replay fixture: whatever the harness must emit around a
 * long run of output so the stream is well formed end to end — most importantly closing any
 * synchronized-output block it opened, or xterm would never render and never reveal.
 *
 * This deliberately says nothing about the states a harness passes through mid-session. Those
 * are `recipeStages`, driven one at a time so a test can assert the state between them.
 */
function recipeSequences(recipe: AnsiRecipe) {
  switch (recipe) {
    case 'codex':
      return { prefix: '\u001b[?2026h\rprogress 0%', suffix: '\rprogress 100%\u001b[?2026l' };
    case 'claude':
      return { prefix: '\u001b[?1049hclaude fixture\r\n', suffix: '\u001b[?1049l' };
    case 'pi':
      // No ED3 here: dropping scrollback is a staged action Pi takes mid-session, and using
      // it as stream framing would leave every Pi fixture with no scrollback left to assert on.
      return { prefix: 'pi redraw\r\u001b[2K', suffix: '\r\u001b[2Kpi ready' };
    case 'opencode':
      return {
        prefix: '\u001b[?1049h\u001b[?1000hopencode fixture\r\n',
        suffix: '\u001b[?1000l\u001b[?1049l',
      };
    case 'shell':
      return { prefix: '$ printf fixture\r\n', suffix: '$ ' };
  }
}

/**
 * The three observable moments of a harness's screen ownership, kept separate so a test can
 * assert the state *between* them. Replaying a harness end to end only ever shows the state
 * after `exit`, which is precisely the state that cannot distinguish a harness that entered
 * the alternate screen from one that never did.
 */
export interface AnsiRecipeStages {
  /** What the harness emits when it takes the screen. */
  readonly enter: string;
  /** A representative mid-session repaint the harness performs repeatedly. */
  readonly redraw: string;
  /** What the harness emits when it hands the screen back. */
  readonly exit: string;
}

export function recipeStages(recipe: AnsiRecipe): AnsiRecipeStages {
  switch (recipe) {
    // Inline composer: never leaves the normal buffer, repaints the current row inside a
    // synchronized-output block, and drops scrollback with ED3 rather than scrolling it away.
    case 'codex':
      return {
        enter: '\u001b[?2026h\rcodex progress 0%',
        redraw: '\r\u001b[Kcodex progress 100%\u001b[?2026l',
        exit: '\u001b[3J',
      };
    // Full alternate-screen TUI that must restore the normal buffer untouched on exit.
    case 'claude':
      return {
        enter: '\u001b[?1049h\u001b[2J\u001b[Hclaude alternate frame',
        redraw: '\u001b[3;1Hclaude alternate redraw',
        exit: '\u001b[?1049l',
      };
    // Inline redraw like Codex, plus the Shift+Enter composer newline. That key sequence is
    // deliberately absent here: Shift+Enter is *input*, exercised through the real key handler.
    case 'pi':
      return {
        enter: 'pi prompt draft',
        redraw: '\r\u001b[2Kpi prompt final',
        exit: '\u001b[3J',
      };
    // Alternate screen plus mouse ownership: while `?1000h` is set, clicks belong to the
    // program, and releasing it has to give them back to selection.
    case 'opencode':
      return {
        enter: '\u001b[?1049h\u001b[?1000h\u001b[2J\u001b[Hopencode frame',
        redraw: '\u001b[2;1Hopencode redraw',
        exit: '\u001b[?1000l\u001b[?1049l',
      };
    // An ordinary shell, and the full-screen program an ordinary shell runs.
    case 'shell':
      return {
        enter: '$ printf fixture\r\n',
        redraw: '\u001b[?1049h\u001b[2J\u001b[H\u001b[10;5Hshell tui cell',
        exit: '\u001b[?1049l',
      };
  }
}
