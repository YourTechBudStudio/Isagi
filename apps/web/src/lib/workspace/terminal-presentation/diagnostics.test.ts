import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTerminalDiagnosticsCollector } from './diagnostics.js';

describe('terminal diagnostics privacy boundary', () => {
  it('retains only the declared shape fields, discarding anything a caller attaches', () => {
    const collector = createTerminalDiagnosticsCollector();
    collector.record({
      kind: 'socket_closed',
      reason: 'socket_closed',
      sessionKind: 'agent_session',
      sessionId: 7,
      worktreeId: 1,
      value: 12,
      // A future caller widening the payload must not be able to smuggle content through.
      transcript: '$ cat ~/.ssh/id_ed25519',
      error: new Error('connect ECONNREFUSED 127.0.0.1:7331'),
      url: 'ws://runtime.test/pty/7?token=secret',
    } as never);

    const retained = collector.getSnapshot().recent.at(-1);
    assert.deepEqual(retained, {
      kind: 'socket_closed',
      reason: 'socket_closed',
      sessionKind: 'agent_session',
      sessionId: 7,
      worktreeId: 1,
      surfaceId: undefined,
      paneId: undefined,
      value: 12,
    });
    assert.equal(Object.keys(retained ?? {}).includes('transcript'), false);
  });

  it('refuses label-shaped secrets that pass every plausible shape check', () => {
    const collector = createTerminalDiagnosticsCollector();
    // Each of these is a single token: no whitespace, no slashes, comfortably short. Shape
    // alone cannot tell them apart from a diagnostic name — only the vocabulary can.
    const smuggled = [
      'sk-ant-api03-Zx8f_QmT4Lp',
      'ghp_9aQ2Kd7NvR1sT3uW5xY8',
      'hunter2',
      'noorain.panjwani-laptop.local',
      'AKIAIOSFODNN7EXAMPLE',
    ];

    for (const secret of smuggled) {
      collector.record({ kind: secret, reason: secret } as never);
      const retained = collector.getSnapshot().recent.at(-1);
      assert.equal(retained?.kind, 'unlabeled', `kind retained ${secret}`);
      assert.equal(retained?.reason, 'unlabeled', `reason retained ${secret}`);
    }

    // Nothing smuggled survives anywhere in the snapshot, counters and durations included.
    const serialized = JSON.stringify(collector.getSnapshot());
    for (const secret of smuggled) {
      assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')));
    }
  });

  it('refuses labels that read like messages, and rejects malformed numbers', () => {
    const collector = createTerminalDiagnosticsCollector();
    collector.record({
      kind: 'attach failed: exec /bin/zsh: no such file or directory',
      reason: '/Users/someone/Work/secret-project',
      sessionId: -4,
      value: Number.NaN,
    } as never);

    assert.deepEqual(collector.getSnapshot().recent.at(-1), {
      kind: 'unlabeled',
      reason: 'unlabeled',
      sessionKind: undefined,
      sessionId: undefined,
      worktreeId: undefined,
      surfaceId: undefined,
      paneId: undefined,
      value: undefined,
    });
  });

  it('accepts every label its producers actually emit', () => {
    const collector = createTerminalDiagnosticsCollector();
    // A rejected cache mutation, a retention eviction, and a coordinator finding: the three
    // producers that report a reason distinct from their kind.
    collector.record({ kind: 'operation_rejected', reason: 'placement_mismatch' });
    collector.record({ kind: 'presentation_evicted', reason: 'memory_budget', value: 4096 });
    collector.record({ kind: 'inventory_rejected', reason: 'conflicting_duplicate_identity' });

    assert.deepEqual(
      collector.getSnapshot().recent.map((event) => [event.kind, event.reason]),
      [
        ['operation_rejected', 'placement_mismatch'],
        ['presentation_evicted', 'memory_budget'],
        ['inventory_rejected', 'conflicting_duplicate_identity'],
      ],
    );
  });

  it('keeps gauges to finite numbers under names it knows', () => {
    const collector = createTerminalDiagnosticsCollector();
    collector.setGauges({
      entryCount: 3,
      terminalColumns: 120,
      'last error': 1,
      'sk-ant-api03-Zx8f_QmT4Lp': 1,
      hiddenCount: Number.POSITIVE_INFINITY,
    } as never);

    assert.deepEqual(collector.getSnapshot().gauges, { entryCount: 3, terminalColumns: 120 });
  });

  it('still counts and aggregates durations across sanitized events', () => {
    const collector = createTerminalDiagnosticsCollector();
    collector.record({ kind: 'replay_duration', reason: 'replay_duration', value: 10 });
    collector.record({ kind: 'replay_duration', reason: 'replay_duration', value: 30 });

    assert.equal(collector.getSnapshot().totalEvents, 2);
    assert.equal(collector.getSnapshot().counters.replay_duration, 2);
    assert.deepEqual(collector.getSnapshot().durations.replay_duration, {
      count: 2,
      total: 40,
      min: 10,
      max: 30,
    });
  });
});
