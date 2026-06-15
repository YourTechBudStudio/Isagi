import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { Effect } from 'effect';

import { TmuxBackend, TmuxBackendLive } from './tmux.js';

test('tmux replay captures the full pane and marks replay output', async () => {
  await withFakeTmux(async ({ logPath, path }) => {
    const output = '\u001b[32mhello from tmux\u001b[0m\n';
    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        const backend = yield* TmuxBackend;
        const replayMessages: import('@isagi/contracts').PtyWebSocketOutputMessage[] = [];
        yield* backend.replay({
          ref: { schemaVersion: 1, backend: 'tmux', sessionName: 'isagi-session-1' },
          logPath: null,
          bytes: null,
          send: (message) => replayMessages.push(message),
        });
        return replayMessages;
      }).pipe(Effect.provide(TmuxBackendLive)),
    );

    assert.deepEqual(messages, [
      { type: 'replay_start', bytes: Buffer.byteLength(output) },
      { type: 'output', data: output, replay: true },
      { type: 'replay_end' },
    ]);
    assert.deepEqual(readTmuxCalls(logPath), [
      {
        args: ['-L', 'isagi', 'capture-pane', '-p', '-e', '-S', '-', '-t', 'isagi-session-1'],
      },
    ]);
    assert.equal(process.env.PATH, path);
  });
});

test('tmux launch configures Isagi terminal behavior before starting the session', async () => {
  await withFakeTmux(async ({ logPath }) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const backend = yield* TmuxBackend;
        return yield* backend.launch({
          ptySessionId: 17,
          backendSessionName: 'isagi-session-17',
          command: 'zsh',
          cwd: '/repo/isagi',
          env: { ...process.env },
          cols: 80,
          rows: 24,
          logPath: null,
          onExit: () => {},
        });
      }).pipe(Effect.provide(TmuxBackendLive)),
    );

    assert.deepEqual(readTmuxCalls(logPath), [
      {
        args: [
          '-L',
          'isagi',
          'set-option',
          '-g',
          'status',
          'off',
          ';',
          'set-option',
          '-g',
          'mouse',
          'off',
          ';',
          'set-option',
          '-gq',
          'extended-keys',
          'on',
          ';',
          'set-option',
          '-gq',
          'extended-keys-format',
          'csi-u',
          ';',
          'set-option',
          '-gq',
          'xterm-keys',
          'on',
          ';',
          'set-option',
          '-gq',
          'terminal-features[99]',
          'xterm*:extkeys',
          ';',
          'set-option',
          '-gq',
          'terminal-overrides[99]',
          'xterm*:smcup@:rmcup@',
          ';',
          'new-session',
          '-d',
          '-s',
          'isagi-session-17',
          '-c',
          '/repo/isagi',
          'zsh',
        ],
      },
    ]);
  });
});

async function withFakeTmux(
  run: (input: { readonly logPath: string; readonly path: string }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), 'isagi-tmux-adapter-'));
  const bin = join(root, 'bin');
  const logPath = join(root, 'tmux-calls.jsonl');
  const tmuxPath = join(bin, 'tmux');
  const previousPath = process.env.PATH;
  const previousLogPath = process.env.ISAGI_FAKE_TMUX_LOG;
  try {
    mkdirSync(bin);
    writeFileSync(
      tmuxPath,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

appendFileSync(
  process.env.ISAGI_FAKE_TMUX_LOG,
  JSON.stringify({ args: process.argv.slice(2) }) + '\\n',
);

if (process.argv.includes('capture-pane')) {
  process.stdout.write('\\u001b[32mhello from tmux\\u001b[0m\\n');
}
`,
      'utf8',
    );
    chmodSync(tmuxPath, 0o755);
    const path = previousPath ? `${bin}${delimiter}${previousPath}` : bin;
    process.env.PATH = path;
    process.env.ISAGI_FAKE_TMUX_LOG = logPath;
    await run({ logPath, path });
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousLogPath === undefined) {
      delete process.env.ISAGI_FAKE_TMUX_LOG;
    } else {
      process.env.ISAGI_FAKE_TMUX_LOG = previousLogPath;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function readTmuxCalls(logPath: string) {
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { readonly args: readonly string[] });
}
