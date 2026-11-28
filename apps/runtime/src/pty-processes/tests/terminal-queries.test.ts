import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { Effect, Layer, type Scope } from 'effect';

import {
  type AppearanceTheme,
  type PtyStreamOutputMessageSet,
  terminalPalette,
} from '@isagi/shared/contracts';

import { CliAccessNone } from '../../cli-access/testing.js';
import { publishOnlyRecordingEventBus } from '../../platform/events/testing.js';
import { DataDirectory, RuntimeDatabase } from '../../platform/persistence/index.js';
import { makeTestDataDirectory } from '../../platform/persistence/testing.js';
import { UserShell } from '../../platform/process/index.js';
import { NodePtyBackend } from '../adapters/node-pty.js';
import { PtyBackendCatalog } from '../backend.js';
import { PtyForegroundState } from '../foreground-state.js';
import { LaunchEnvironment } from '../launch-environment.js';
import { PtyRepository } from '../repository.js';
import { PtyService } from '../service.js';
import { fakeBackendCatalog, ptyTestRuntimeConfig } from '../testing.js';

// The runtime is a node-pty program's terminal of record for queries (`service/terminal-queries.ts`). These tests
// run a real program under the real node-pty backend through the PTY service and check what it is answered, what an
// attachment sees and what the log keeps.

const ESC = '\x1b';

// A program that asks its terminal one question and prints the answer as plain (JSON-escaped) text. Raw mode keeps
// the TTY from echoing the answer back as output. With `wait`, it asks only after its first input byte, so a test can
// put an attachment in place first.
const askScript = `
const [query, terminator, wait] = process.argv.slice(1);
process.stdin.setRawMode(true);
let answer = '';
let asked = false;
const ask = () => { asked = true; process.stdout.write(query); };
process.stdin.on('data', (chunk) => {
  if (!asked) return ask();
  answer += chunk.toString('latin1');
  if (answer.endsWith(terminator)) {
    process.stdout.write('answer:' + JSON.stringify(answer) + '\\n');
    process.exit(0);
  }
});
if (wait !== 'wait') ask();
`;

function askLaunch(query: string, terminator: string, wait: 'wait' | 'now') {
  return {
    command: process.execPath,
    args: ['-e', askScript, query, terminator, wait],
    cwd: process.cwd(),
    launchMode: 'direct' as const,
  };
}

function testUserShell(): UserShell['Service'] {
  return {
    environment: {
      _tag: 'Available' as const,
      values: { HOME: process.env.HOME ?? '/tmp', PATH: process.env.PATH ?? '/usr/bin:/bin' },
    },
    run: () => Effect.die('PTY terminal-query tests do not run user-shell commands.'),
  };
}

const realNodePtyCatalog = Layer.effect(
  PtyBackendCatalog,
  Effect.gen(function* () {
    const nodePty = yield* NodePtyBackend;
    return fakeBackendCatalog({ nodePty });
  }),
).pipe(Layer.provide(NodePtyBackend.layer));

function serviceLayer(dataRoot: string, theme: AppearanceTheme) {
  const directory = Layer.succeed(DataDirectory, makeTestDataDirectory(dataRoot));
  const database = RuntimeDatabase.layer.pipe(Layer.provide(directory));
  const persistence = Layer.mergeAll(
    directory,
    database,
    PtyRepository.layer.pipe(Layer.provide(database)),
  );
  const userShell = Layer.succeed(UserShell, testUserShell());
  return PtyService.layerNoDeps.pipe(
    Layer.provide([
      realNodePtyCatalog,
      LaunchEnvironment.layerNoDeps.pipe(Layer.provide([CliAccessNone, userShell])),
      PtyForegroundState.layer,
      ptyTestRuntimeConfig(theme),
      publishOnlyRecordingEventBus('the PTY service does not subscribe').layer,
      userShell,
    ]),
    Layer.provide(persistence),
  );
}

async function withService<A>(
  theme: AppearanceTheme,
  body: Effect.Effect<A, unknown, PtyService | Scope.Scope>,
): Promise<A> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'isagi-pty-terminal-queries-'));
  try {
    return await Effect.runPromise(
      body.pipe(Effect.scoped, Effect.provide(serviceLayer(dataRoot, theme))),
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

function readLog(logPath: string | null) {
  assert.ok(logPath, 'a node-pty process keeps a log');
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
}

const waitUntil = Effect.fnUntraced(function* (label: string, done: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (done()) return;
    yield* Effect.sleep('20 millis');
  }
  assert.fail(`timed out waiting for ${label}`);
});

/** The program's printed answer, once it is in the log. */
const answerInLog = Effect.fnUntraced(function* (logPath: string | null) {
  yield* waitUntil('the program to print its answer', () => readLog(logPath).includes('answer:'));
  const match = /answer:(".*")\n/.exec(readLog(logPath).replaceAll('\r', ''));
  assert.ok(match?.[1], 'the answer line is complete');
  return JSON.parse(match[1]) as string;
});

function liveOutput(messages: readonly PtyStreamOutputMessageSet[]) {
  return messages.flatMap((message) => (message.type === 'output' ? [message.data] : [])).join('');
}

for (const theme of ['light', 'dark'] as const) {
  test(`a detached program's OSC 11 query gets the ${theme} theme background and never reaches the log`, () =>
    withService(
      theme,
      Effect.gen(function* () {
        const pty = yield* PtyService;
        const launched = yield* pty.launch(askLaunch(`${ESC}]11;?\x07`, `${ESC}\\`, 'now'));
        const answer = yield* answerInLog(launched.logPath);
        const hex = terminalPalette[theme].background.slice(1);
        const [red, green, blue] = [0, 2, 4].map((at) => hex.slice(at, at + 2).repeat(2));
        assert.equal(answer, `${ESC}]11;rgb:${red}/${green}/${blue}${ESC}\\`);
        assert.equal(readLog(launched.logPath).includes(`${ESC}]11;?`), false);
      }),
    ));
}

test('with only a read-only attachment, the runtime answers a cursor-position query itself', () =>
  withService(
    'light',
    Effect.gen(function* () {
      const pty = yield* PtyService;
      const launched = yield* pty.launch(askLaunch(`${ESC}[6n`, 'R', 'wait'));
      const messages: PtyStreamOutputMessageSet[] = [];
      yield* pty.attach({
        ptyProcessId: launched.ptyProcessId,
        mode: 'read_only',
        send: (message) => messages.push(message),
      });
      yield* pty.writeInput({ ptyProcessId: launched.ptyProcessId, data: 'g' });
      assert.equal(yield* answerInLog(launched.logPath), `${ESC}[1;1R`);
      assert.equal(liveOutput(messages).includes(`${ESC}[6n`), false);
      assert.equal(readLog(launched.logPath).includes(`${ESC}[6n`), false);
    }),
  ));

test('with an interactive attachment, a cursor-position query goes to it and the runtime stays silent', () =>
  withService(
    'light',
    Effect.gen(function* () {
      const pty = yield* PtyService;
      const launched = yield* pty.launch(askLaunch(`${ESC}[6n`, 'R', 'wait'));
      const messages: PtyStreamOutputMessageSet[] = [];
      const attachment = yield* pty.attach({
        ptyProcessId: launched.ptyProcessId,
        mode: 'interactive',
        send: (message) => messages.push(message),
      });
      yield* pty.write({
        ptyProcessId: launched.ptyProcessId,
        attachmentId: attachment.attachmentId,
        data: 'g',
      });
      yield* waitUntil('the query to reach the attachment', () =>
        liveOutput(messages).includes(`${ESC}[6n`),
      );
      // The attachment answers as a pane would. Had the runtime also answered, the program would have printed the
      // runtime's `1;1` instead, because it takes the first complete answer.
      yield* pty.write({
        ptyProcessId: launched.ptyProcessId,
        attachmentId: attachment.attachmentId,
        data: `${ESC}[5;7R`,
      });
      assert.equal(yield* answerInLog(launched.logPath), `${ESC}[5;7R`);
      assert.equal(readLog(launched.logPath).includes(`${ESC}[6n`), false);
    }),
  ));
