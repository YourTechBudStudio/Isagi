import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Effect } from 'effect';

import { terminalSettingsDefaults } from '@isagi/contracts';

import {
  createTerminalPresentationCache,
  type TerminalAttachmentHandle,
} from '../terminal-cache/index.js';
import type { TerminalPresentationController } from './controller.js';
import { startTerminalPresentation, type TerminalPresentationStart } from './start-presentation.js';
import { createFakeTerminalEnvironment } from './test-environment.js';

const PLACEMENT = { worktreeId: 1, surfaceId: 2, paneId: 3 } as const;
const IDENTITY = { kind: 'agent_session', sessionId: 7 } as const;

describe('terminal presentation preparation', () => {
  it('builds no terminal until the terminal font is ready', async () => {
    const { env, attachment, start } = begin();
    const pending = start();
    await settle();

    assert.equal(env.terminals.length, 0, 'xterm measures its cell box once — not before fonts');
    assert.equal(attachment.isCurrentMutable(), true, 'the entry stays reserved while waiting');

    env.resolveFonts();
    const result = await pending;

    assert.equal(result.status, 'started');
    assert.equal(env.terminals.length, 1);
    assert.equal(env.terminal.openCount, 1);
    if (result.status === 'started') result.controller.dispose();
  });

  it('releases the reserved entry when a newer request supersedes the wait', async () => {
    const { env, attachment, start } = begin();
    const pending = start(() => true);
    env.resolveFonts();
    const result = await pending;

    assert.equal(result.status, 'cancelled');
    assert.equal(env.terminals.length, 0);
    assert.equal(
      attachment.isCurrentMutable(),
      false,
      'preparation was aborted, not left dangling',
    );
  });

  it('reports construction failure with diagnostic detail instead of swallowing it', async () => {
    const { env, attachment, start } = begin();
    env.terminalCreationFailure = 'WebGL2RenderingContext is not available';
    const pending = start();
    env.resolveFonts();
    const result = await pending;

    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') throw new Error('Expected a failed preparation.');
    assert.equal(result.failure.detail, 'WebGL2RenderingContext is not available');
    // Released, so the pane's retry can begin a fresh attachment rather than
    // sitting on a half-prepared entry forever.
    assert.equal(attachment.isCurrentMutable(), false);
  });
});

function begin() {
  const env = createFakeTerminalEnvironment();
  const cache = createTerminalPresentationCache<TerminalPresentationController>({
    settings: terminalSettingsDefaults.cache,
  });
  const session = cache.ensureSession(IDENTITY, PLACEMENT);
  const started = session.beginAttachment();
  if (started.status !== 'started') throw new Error('Expected attachment.');
  const attachment: TerminalAttachmentHandle<TerminalPresentationController> = started.attachment;

  const start = (isCancelled: () => boolean = () => false): Promise<TerminalPresentationStart> =>
    startTerminalPresentation({
      attachment,
      scrollbackLines: 1000,
      initiallyInteractive: true,
      parkingRoot: env.parkingRoot,
      environment: env,
      initialViewport: null,
      onViewport: () => undefined,
      onEvent: () => undefined,
      resolveUrl: () => Effect.succeed('ws://runtime.test/pty/7'),
      isCancelled,
    });

  return { env, cache, attachment, start };
}

async function settle() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
