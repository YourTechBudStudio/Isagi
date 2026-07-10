import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { opencodePluginSource } from './artifacts.js';

test('generated OpenCode plugin persists only established root-native evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'isagi-opencode-root-plugin-'));
  const previousEnvironment = captureEnvironment();
  const originalError = console.error;
  try {
    Object.assign(process.env, {
      ISAGI_AGENT_SESSION_ID: '10',
      ISAGI_PTY_PROCESS_ID: '20',
      ISAGI_HARNESS_ARTIFACT_DIRECTORY: join(root, 'artifacts'),
      ISAGI_HARNESS_METADATA_PATH: join(root, 'artifacts', 'harness.json'),
    });
    console.error = () => undefined;
    const observer = await loadObserver(root, 'new-root');
    const rootCreated = {
      id: 'evt_root_created',
      type: 'session.created',
      properties: { info: { id: 'root-1' } },
    };
    const rootStatus = {
      id: 'evt_root_status',
      type: 'session.status',
      properties: { sessionID: 'root-1', status: { type: 'busy' } },
    };
    await observer.event({ event: rootCreated });
    await observer.event({ event: rootStatus });
    const rootQuestionAsked = {
      id: 'evt_root_question_asked',
      type: 'question.asked',
      properties: { id: 'que-root', sessionID: 'root-1', questions: [] },
    };
    const rootQuestionReplied = {
      id: 'evt_root_question_replied',
      type: 'question.replied',
      properties: { requestID: 'que-root', sessionID: 'root-1', answers: [[]] },
    };
    const rootQuestionRejected = {
      id: 'evt_root_question_rejected',
      type: 'question.rejected',
      properties: { requestID: 'que-root-2', sessionID: 'root-1' },
    };
    await observer.event({ event: rootQuestionAsked });
    await observer.event({ event: rootQuestionReplied });
    await observer.event({ event: rootQuestionRejected });
    await observer.event({
      event: { type: 'session.idle', properties: { sessionID: 'root-1' } },
    });
    await observer.event({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-1', parentID: 'root-1' } },
      },
    });
    await observer.event({
      event: { type: 'session.status', properties: { sessionID: 'child-1', status: 'busy' } },
    });
    await observer.event({
      event: {
        type: 'session.error',
        properties: { sessionID: 'child-1', error: { message: 'redacted' } },
      },
    });
    await observer.event({
      event: {
        id: 'evt_child_question',
        type: 'question.asked',
        properties: { id: 'que-child', sessionID: 'child-1', questions: [] },
      },
    });
    await observer.event({
      event: { type: 'session.status', properties: { sessionID: 'unproven-root', status: 'busy' } },
    });

    await observer.event({
      event: { type: 'session.created', properties: { info: { id: 'root-2' } } },
    });
    const olderRootStatus = {
      type: 'session.status',
      properties: { sessionID: 'root-1', status: 'busy' },
    };
    await observer.event({ event: olderRootStatus });

    assert.deepEqual(readMetadata(root).harnessSessionId, 'root-2');
    assert.deepEqual(readEvents(root, 'root-1'), [
      rootCreated,
      rootStatus,
      rootQuestionAsked,
      rootQuestionReplied,
      rootQuestionRejected,
      olderRootStatus,
    ]);
    assert.equal(existsSync(logPath(root, 'child-1')), false);
    assert.equal(existsSync(logPath(root, 'unproven-root')), false);

    const resumed = await loadObserver(root, 'resumed-root');
    const resumedStatus = {
      id: 'evt_resumed_status',
      type: 'session.status',
      properties: { sessionID: 'resumed-root', status: 'busy' },
    };
    await resumed.event({ event: resumedStatus });
    assert.deepEqual(readMetadata(root).harnessSessionId, 'resumed-root');
    assert.deepEqual(readEvents(root, 'resumed-root'), [resumedStatus]);
  } finally {
    console.error = originalError;
    restoreEnvironment(previousEnvironment);
    rmSync(root, { recursive: true, force: true });
  }
});

async function loadObserver(root: string, resumedRootSessionId: string | null) {
  if (resumedRootSessionId)
    process.env.ISAGI_OPENCODE_RESUMED_ROOT_SESSION_ID = resumedRootSessionId;
  else delete process.env.ISAGI_OPENCODE_RESUMED_ROOT_SESSION_ID;
  const path = join(root, `plugin-${resumedRootSessionId ?? 'new'}.mjs`);
  writeFileSync(path, opencodePluginSource(), 'utf8');
  const plugin = (await import(`${pathToFileURL(path).href}?${Date.now()}-${Math.random()}`)) as {
    readonly IsagiSessionObserver: () => Promise<{
      readonly event: (input: { readonly event: unknown }) => Promise<void>;
    }>;
  };
  return plugin.IsagiSessionObserver();
}

function readMetadata(root: string) {
  return JSON.parse(readFileSync(join(root, 'artifacts', 'harness.json'), 'utf8')) as {
    readonly harnessSessionId: string;
  };
}

function readEvents(root: string, harnessSessionId: string) {
  return readFileSync(logPath(root, harnessSessionId), 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { readonly event: unknown }).event);
}

function logPath(root: string, harnessSessionId: string) {
  return join(root, 'artifacts', `${Buffer.from(harnessSessionId).toString('hex')}.harness.jsonl`);
}

function captureEnvironment() {
  return {
    agentSessionId: process.env.ISAGI_AGENT_SESSION_ID,
    ptyProcessId: process.env.ISAGI_PTY_PROCESS_ID,
    artifactDirectory: process.env.ISAGI_HARNESS_ARTIFACT_DIRECTORY,
    metadataPath: process.env.ISAGI_HARNESS_METADATA_PATH,
    resumedRoot: process.env.ISAGI_OPENCODE_RESUMED_ROOT_SESSION_ID,
  };
}

function restoreEnvironment(environment: ReturnType<typeof captureEnvironment>) {
  restore('ISAGI_AGENT_SESSION_ID', environment.agentSessionId);
  restore('ISAGI_PTY_PROCESS_ID', environment.ptyProcessId);
  restore('ISAGI_HARNESS_ARTIFACT_DIRECTORY', environment.artifactDirectory);
  restore('ISAGI_HARNESS_METADATA_PATH', environment.metadataPath);
  restore('ISAGI_OPENCODE_RESUMED_ROOT_SESSION_ID', environment.resumedRoot);
}

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
