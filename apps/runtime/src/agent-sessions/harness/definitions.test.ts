import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentHarness } from '@isagi/contracts';

import { harnessDefinition, harnessDefinitions, supportedHarnesses } from './definitions.js';

test('harness definitions are exhaustive and expose real capabilities', () => {
  const expected = ['pi', 'opencode', 'claude', 'codex'] satisfies AgentHarness[];
  assert.deepEqual([...supportedHarnesses].sort(), [...expected].sort());
  assert.deepEqual(Object.keys(harnessDefinitions).sort(), [...expected].sort());

  for (const harness of expected) {
    const definition = harnessDefinition(harness);
    assert.equal(definition.id, harness);
    assert.ok(definition.displayName);
    assert.ok(definition.executable);
    assert.equal(definition.probe.command, definition.executable);
    assert.equal(typeof definition.launch.interactive, 'function');
    assert.equal(typeof definition.launch.headless, 'function');
    assert.equal(typeof definition.lifecycle.reduce, 'function');
    assert.equal(typeof definition.conversation.read, 'function');
    assert.equal(typeof definition.observation.runtimeArtifacts, 'function');
  }

  assert.equal(
    harnessDefinition('codex').observation.locateNativeSources instanceof Function,
    true,
  );
  assert.equal(harnessDefinition('pi').observation.locateNativeSources, undefined);
});

test('Docs integrations resolve documented native targets without manufacturing home paths', () => {
  const home = '/Users/dev person';
  assert.deepEqual(harnessDefinition('pi').docs.resolveTarget({ HOME: home }), {
    _tag: 'Resolved',
    path: '/Users/dev person/.pi/agent/skills/isagi-docs',
  });
  assert.deepEqual(
    harnessDefinition('claude').docs.resolveTarget({
      HOME: home,
      CLAUDE_CONFIG_DIR: '/custom/claude',
    }),
    { _tag: 'Resolved', path: '/custom/claude/skills/isagi-docs' },
  );
  assert.deepEqual(
    harnessDefinition('opencode').docs.resolveTarget({ XDG_CONFIG_HOME: '/xdg config' }),
    { _tag: 'Resolved', path: '/xdg config/opencode/commands/isagi-docs.md' },
  );
  assert.deepEqual(harnessDefinition('codex').docs.resolveTarget({}), {
    _tag: 'MissingEnvironmentRoot',
    harness: 'codex',
    required: 'HOME',
  });
});
