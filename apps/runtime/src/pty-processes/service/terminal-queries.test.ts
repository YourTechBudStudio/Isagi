import assert from 'node:assert/strict';
import test from 'node:test';

import { type AppearanceTheme, terminalPalette } from '@isagi/contracts';

import { createTerminalQueryFilter, type TerminalQueryFilter } from './terminal-queries.js';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;
/** What a removed query leaves in its place: ST, which ends any sequence the query's ESC would have. */
const removed = ST;

const themes: readonly AppearanceTheme[] = ['dark', 'light'];

/** Feeds every chunk, then flushes, and concatenates what came out. */
function run(filter: TerminalQueryFilter, chunks: readonly string[]) {
  const replies: string[] = [];
  let live = '';
  let log = '';
  for (const chunk of chunks) {
    const output = filter.push(chunk);
    replies.push(...output.replies);
    live += output.live;
    log += output.log;
  }
  const trailing = filter.flush();
  return { replies, live: live + trailing, log: log + trailing };
}

const darkFilter = () => createTerminalQueryFilter(terminalPalette.dark);

test('identity queries are answered as xterm.js 6 would and replaced by ST in live and log', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    [`${ESC}[c`, `${ESC}[?1;2c`],
    [`${ESC}[0c`, `${ESC}[?1;2c`],
    [`${ESC}[>c`, `${ESC}[>0;276;0c`],
    [`${ESC}[>0c`, `${ESC}[>0;276;0c`],
    [`${ESC}[5n`, `${ESC}[0n`],
  ];
  for (const theme of themes) {
    for (const [query, reply] of cases) {
      const output = createTerminalQueryFilter(terminalPalette[theme]).push(`a${query}b`);
      const ab = `a${removed}b`;
      assert.deepEqual(output, { replies: [reply], live: ab, log: ab }, `${theme} ${query}`);
    }
  }
});

test('colour queries are answered from the theme palette with either terminator, always ending in ST', () => {
  const expected: Record<AppearanceTheme, { readonly fg: string; readonly bg: string }> = {
    dark: { fg: 'rgb:caca/d3d3/f5f5', bg: 'rgb:2d2d/3131/4545' },
    light: { fg: 'rgb:4c4c/4f4f/6969', bg: 'rgb:efef/f1f1/f5f5' },
  };
  for (const theme of themes) {
    for (const terminator of [BEL, ST]) {
      const filter = createTerminalQueryFilter(terminalPalette[theme]);
      assert.deepEqual(filter.push(`${ESC}]10;?${terminator}`), {
        replies: [`${ESC}]10;${expected[theme].fg}${ST}`],
        live: removed,
        log: removed,
      });
      assert.deepEqual(filter.push(`${ESC}]11;?${terminator}`), {
        replies: [`${ESC}]11;${expected[theme].bg}${ST}`],
        live: removed,
        log: removed,
      });
    }
  }
});

test('state queries fall back to 1;1 without forwarding and go live, unanswered, with it', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    [`${ESC}[6n`, `${ESC}[1;1R`],
    [`${ESC}[?6n`, `${ESC}[?1;1R`],
  ];
  for (const [query, fallback] of cases) {
    const filter = darkFilter();
    const xy = `x${removed}y`;
    assert.deepEqual(filter.push(`x${query}y`), { replies: [fallback], live: xy, log: xy });

    filter.setStateQueryForwarding(true);
    assert.deepEqual(filter.push(`x${query}y`), { replies: [], live: `x${query}y`, log: xy });

    filter.setStateQueryForwarding(false);
    assert.deepEqual(filter.push(query), { replies: [fallback], live: removed, log: removed });
  }
});

test('a query split at every byte boundary is recognised the same as whole', () => {
  const queries = [
    `${ESC}[c`,
    `${ESC}[>0c`,
    `${ESC}[5n`,
    `${ESC}[?6n`,
    `${ESC}]10;?${BEL}`,
    `${ESC}]11;?${ST}`,
  ];
  for (const query of queries) {
    const data = `before${query}after`;
    const whole = run(darkFilter(), [data]);
    for (let cut = 1; cut < data.length; cut += 1) {
      assert.deepEqual(
        run(darkFilter(), [data.slice(0, cut), data.slice(cut)]),
        whole,
        `${JSON.stringify(query)} cut at ${cut}`,
      );
    }
    // And one byte at a time.
    assert.deepEqual(run(darkFilter(), [...data]), whole, JSON.stringify(query));
  }
});

test('unrecognised sequences pass through untouched', () => {
  const sequences = [
    `${ESC}[?u`, // kitty keyboard query
    `${ESC}[18t`, // xterm.js 6 doesn't answer it (window options are off), so neither does the runtime
    `${ESC}[1c`, // DA1 with a non-zero parameter: xterm.js 6 stays silent
    `${ESC}[>1c`, // the same for DA2
    `${ESC}[?2026$p`, // DECRQM
    `${ESC}]4;1;?${BEL}`, // OSC 4
    `${ESC}]10;?;?${BEL}`, // stacked colour queries
    `${ESC}]6973;isagi;token;foreground-start${BEL}`, // Isagi's own shell-integration marker
    '\x9b6n', // C1 CSI
    `${ESC}[31mred${ESC}[0m`,
  ];
  for (const sequence of sequences) {
    const data = `<${sequence}>`;
    assert.deepEqual(
      darkFilter().push(data),
      { replies: [], live: data, log: data },
      JSON.stringify(sequence),
    );
  }
});

test('ordinary output is never held back', () => {
  const filter = darkFilter();
  for (const chunk of ['plain text\r\n', `${ESC}[1`, 'm bold', `${ESC}[31m`, `${ESC}]0;title`]) {
    assert.deepEqual(filter.push(chunk), { replies: [], live: chunk, log: chunk });
  }
  assert.equal(filter.flush(), '');
});

test('a held partial prefix is released by flush as plain output', () => {
  for (const partial of [
    ESC,
    `${ESC}[`,
    `${ESC}[>`,
    `${ESC}]1`,
    `${ESC}]11;?`,
    `${ESC}]11;?${ESC}`,
  ]) {
    const filter = darkFilter();
    assert.deepEqual(filter.push(`out${partial}`), { replies: [], live: 'out', log: 'out' });
    assert.equal(filter.flush(), partial);
    assert.equal(filter.flush(), '');
  }
});

test('a held prefix that turns out not to be a query is released with the next chunk', () => {
  const filter = darkFilter();
  assert.deepEqual(filter.push(`a${ESC}[`), { replies: [], live: 'a', log: 'a' });
  assert.deepEqual(filter.push('2Jb'), { replies: [], live: `${ESC}[2Jb`, log: `${ESC}[2Jb` });
});

test('several queries in one chunk are answered in order and the text around them is kept', () => {
  const filter = darkFilter();
  const output = filter.push(
    `one${ESC}]11;?${ST}two${ESC}[6n${ESC}[?u three${ESC}[c${ESC}]10;?${BEL}four${ESC}[`,
  );
  assert.deepEqual(output, {
    replies: [
      `${ESC}]11;rgb:2d2d/3131/4545${ST}`,
      `${ESC}[1;1R`,
      `${ESC}[?1;2c`,
      `${ESC}]10;rgb:caca/d3d3/f5f5${ST}`,
    ],
    live: `one${removed}two${removed}${ESC}[?u three${removed}${removed}four`,
    log: `one${removed}two${removed}${ESC}[?u three${removed}${removed}four`,
  });
  // The trailing `ESC [` completes into DSR 5 in the next chunk, after everything above.
  assert.deepEqual(filter.push('5n!'), {
    replies: [`${ESC}[0n`],
    live: `${removed}!`,
    log: `${removed}!`,
  });
});

test('a query that interrupts an unfinished sequence still ends that sequence, in one chunk or split', () => {
  // In xterm.js 6 a query's leading ESC ends an unfinished OSC/DCS string and aborts an unfinished
  // CSI/escape sequence. Dropping the query outright would, for example, leave `VISIBLE` inside the
  // title; ST in its place ends the earlier sequence the same way (checked against xterm.js 6).
  const unfinished = [`${ESC}]0;title`, `${ESC}[3`, ESC, `${ESC}Pq`, `${ESC}_apc`];
  for (const prefix of unfinished) {
    for (const query of [`${ESC}[c`, `${ESC}]11;?${BEL}`, `${ESC}[6n`]) {
      const data = `${prefix}${query}VISIBLE`;
      const expected = `${prefix}${removed}VISIBLE`;
      const whole = run(darkFilter(), [data]);
      assert.equal(whole.live, expected, JSON.stringify(data));
      assert.equal(whole.log, expected, JSON.stringify(data));
      assert.equal(whole.replies.length, 1, JSON.stringify(data));
      for (let cut = 1; cut < data.length; cut += 1) {
        assert.deepEqual(
          run(darkFilter(), [data.slice(0, cut), data.slice(cut)]),
          whole,
          `${JSON.stringify(data)} cut at ${cut}`,
        );
      }
    }
  }
});
