import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CommandStatus } from '@isagi/contracts';

import { workbenchCopy } from '../../copy/index.js';
import {
  commandAffordances,
  commandAttentionState,
  commandDetailNotice,
  type CommandPresentation,
} from './command-attention.js';

/**
 * The shared command presentation rules. These used to live as two byte-identical
 * copies inside the drawer and the status strip, and the duplication is exactly
 * how `suspended` would have shipped as a silent `idle`: neither copy would have
 * failed to compile, and neither would have looked wrong on its own.
 *
 * Every status is asserted, not just the new one. A matrix that only covers the
 * variant being added cannot catch the next variant inheriting a default.
 */

const ALL_STATUSES: readonly CommandStatus[] = [
  'idle',
  'running',
  'exited',
  'stopped',
  'failed',
  'suspended',
];

const ALL_PRESENTATIONS: readonly CommandPresentation[] = ['configured', 'removed', 'managed'];

describe('commandAttentionState', () => {
  it('maps every status to exactly one attention signal', () => {
    assert.deepEqual(
      ALL_STATUSES.map((status) => [status, commandAttentionState(status)]),
      [
        ['idle', 'idle'],
        ['running', 'working'],
        ['exited', 'idle'],
        ['stopped', 'idle'],
        ['failed', 'error'],
        ['suspended', 'waiting'],
      ],
    );
  });

  it('reads a suspended command as waiting on the user, never as working or idle', () => {
    // The distinction that matters on screen: a suspended command is still, not
    // busy, and it is not finished either. `waiting` is the only signal that says
    // "nothing is happening and that is your call to make".
    assert.equal(commandAttentionState('suspended'), 'waiting');
    assert.notEqual(commandAttentionState('suspended'), commandAttentionState('stopped'));
    assert.notEqual(commandAttentionState('suspended'), commandAttentionState('running'));
  });
});

describe('commandAffordances', () => {
  it('offers Stop for a suspended command in every presentation', () => {
    // Stop is the only way to clear a resume intent without editing config, so a
    // removed or managed suspension that could not be stopped would be a state
    // the user has no way out of.
    for (const presentation of ALL_PRESENTATIONS) {
      assert.equal(
        commandAffordances('suspended', presentation).canStop,
        true,
        `expected Stop for a ${presentation} suspended command`,
      );
    }
  });

  it('offers Run alongside Stop for a configured suspended command', () => {
    const affordances = commandAffordances('suspended', 'configured');

    // The one status where both make sense at once: Run resumes it now instead of
    // waiting for the next activation, Stop abandons the intent entirely.
    assert.deepEqual(affordances, { canRun: true, canStop: true, canRestart: true });
  });

  it('withholds Run and Restart from commands with no catalog entry to launch', () => {
    for (const presentation of ['removed', 'managed'] as const) {
      assert.deepEqual(commandAffordances('suspended', presentation), {
        canRun: false,
        canStop: true,
        canRestart: false,
      });
    }
  });

  it('never offers Run for a running command, and never offers Stop for a finished one', () => {
    assert.equal(commandAffordances('running', 'configured').canRun, false);
    assert.equal(commandAffordances('running', 'configured').canStop, true);
    for (const status of ['idle', 'exited', 'stopped', 'failed'] as const) {
      assert.equal(
        commandAffordances(status, 'configured').canStop,
        false,
        `expected no Stop for ${status}`,
      );
    }
  });
});

describe('commandDetailNotice', () => {
  it('shows nothing for an ordinary configured status', () => {
    // The rule the drawer promises: a command that is simply running, idle, or
    // exited never grows an explanatory paragraph above its output.
    for (const status of ['idle', 'running', 'exited', 'stopped', 'failed'] as const) {
      assert.equal(
        commandDetailNotice({ status, presentation: 'configured' }),
        null,
        `expected no notice for a configured ${status} command`,
      );
    }
  });

  it('explains a suspension in every presentation, with the facts that presentation has', () => {
    const notices = ALL_PRESENTATIONS.map(
      (presentation) => commandDetailNotice({ status: 'suspended', presentation })!,
    );

    for (const notice of notices) {
      assert.equal(notice.tone, 'waiting');
    }
    // Three genuinely different situations, so three different sentences. A
    // removed entry is gone from a readable catalog; a managed one is unknown
    // because the catalog itself could not be read.
    assert.equal(new Set(notices.map((notice) => notice.text)).size, 3);
    assert.equal(notices[0]?.text, workbenchCopy.commandSuspendedDetail);
    assert.equal(notices[1]?.text, workbenchCopy.commandSuspendedRemovedDetail);
    assert.equal(notices[2]?.text, workbenchCopy.commandSuspendedManagedDetail);
  });

  it('does not promise that a suspended command restarts when the user comes back', () => {
    // After a runtime restart the user *is* back and nothing auto-starts. Copy
    // that said "when you return" would be a lie in exactly the case where the
    // suspension is visible longest.
    const text = commandDetailNotice({ status: 'suspended', presentation: 'configured' })!.text;

    assert.doesNotMatch(text, /come back|when you return/i);
    assert.match(text, /next activation/);
  });

  it('collapses a removed suspension into one notice instead of stacking two', () => {
    const notice = commandDetailNotice({ status: 'suspended', presentation: 'removed' })!;

    // The suspension copy already states the entry is gone, so the standalone
    // removed notice would be a second band saying an overlapping thing.
    assert.equal(notice.text, workbenchCopy.commandSuspendedRemovedDetail);
    assert.notEqual(notice.text, workbenchCopy.commandRemovedDetail);
    assert.match(notice.text, /config entry is gone/);
  });

  it('carries the config parse error on a suspended managed command', () => {
    const notice = commandDetailNotice({
      status: 'suspended',
      presentation: 'managed',
      configDiagnostic: '.isagi/config.yaml\nbad indentation',
    })!;

    // Fixing the config is the only thing that lets this command resume, so the
    // error that has to be fixed travels with the notice that asks for it.
    assert.equal(notice.detail, '.isagi/config.yaml\nbad indentation');
  });

  it('voices a run diagnostic with web-owned copy and keeps the runtime string as detail', () => {
    const notice = commandDetailNotice({
      status: 'running',
      presentation: 'configured',
      runDiagnostic: {
        reason: 'process_control_failed',
        detail: 'Could not stop the process while leaving the worktree: kill ESRCH',
      },
    })!;

    assert.equal(notice.tone, 'warning');
    assert.equal(notice.text, workbenchCopy.commandRunDiagnostic.process_control_failed);
    // The runtime's sentence is never promoted to the voiced summary — it is
    // labelled diagnostic detail (ADR 0004).
    assert.equal(
      notice.detail,
      'Could not stop the process while leaving the worktree: kill ESRCH',
    );
  });

  it('lets a suspension outrank a run diagnostic, and a diagnostic outrank standing context', () => {
    const suspended = commandDetailNotice({
      status: 'suspended',
      presentation: 'configured',
      runDiagnostic: { reason: 'runtime_stopped', detail: null },
    })!;
    const diagnostic = commandDetailNotice({
      status: 'failed',
      presentation: 'removed',
      runDiagnostic: { reason: 'runtime_stopped', detail: null },
    })!;

    // One band, so precedence is a real decision rather than a rendering order.
    assert.equal(suspended.text, workbenchCopy.commandSuspendedDetail);
    assert.equal(diagnostic.text, workbenchCopy.commandRunDiagnostic.runtime_stopped);
    assert.notEqual(diagnostic.text, workbenchCopy.commandRemovedDetail);
  });

  it('falls back to standing catalog context when there is no status or run to explain', () => {
    assert.deepEqual(commandDetailNotice({ status: 'exited', presentation: 'removed' }), {
      tone: 'warning',
      text: workbenchCopy.commandRemovedDetail,
    });
    assert.deepEqual(
      commandDetailNotice({
        status: 'running',
        presentation: 'managed',
        configDiagnostic: '.isagi/config.yaml\nboom',
      }),
      {
        tone: 'neutral',
        text: workbenchCopy.commandManagedDetail,
        detail: '.isagi/config.yaml\nboom',
      },
    );
  });
});
