import assert from 'node:assert/strict';
import test from 'node:test';

import { Either, Schema } from 'effect';

import { DESKTOP_UPDATE_PROTOCOL_VERSION, desktopUpdateSnapshotSchema } from '@isagi/contracts';

const decode = Schema.decodeUnknownEither(desktopUpdateSnapshotSchema);
const base = {
  protocolVersion: DESKTOP_UPDATE_PROTOCOL_VERSION,
  revision: 1,
  installedVersion: '1.2.3',
};

test('the update snapshot contract accepts the states the coordinator produces', () => {
  for (const snapshot of [
    { ...base, state: 'idle' },
    { ...base, state: 'downloading', targetVersion: '2.0.0', progressPercent: 0 },
    { ...base, state: 'downloading', targetVersion: '2.0.0', progressPercent: 100 },
    { ...base, state: 'ready', targetVersion: '2.0.0' },
    {
      ...base,
      state: 'restart_confirmation',
      targetVersion: '2.0.0',
      activity: { kind: 'working', workingAgentCount: 1 },
    },
    {
      ...base,
      state: 'restart_confirmation',
      targetVersion: '2.0.0',
      activity: { kind: 'unknown' },
    },
    {
      ...base,
      state: 'manual_update_required',
      reason: 'unsupported_installation',
      openFailure: null,
    },
    {
      ...base,
      state: 'manual_update_required',
      reason: 'unsupported_installation',
      openFailure: 'download_page_open_failed',
    },
    { ...base, state: 'failed', operation: 'check', code: 'check_failed' },
    {
      ...base,
      state: 'failed',
      operation: 'download',
      code: 'download_failed',
      targetVersion: '2.0.0',
    },
    // A provider event that omits the version must still decode; the sentence
    // shown to the user degrades instead of the snapshot being rejected.
    { ...base, state: 'failed', operation: 'download', code: 'download_failed', targetVersion: '' },
  ])
    assert.equal(Either.isRight(decode(snapshot)), true, JSON.stringify(snapshot));
});

test('the update snapshot contract rejects states the coordinator can never reach', () => {
  for (const snapshot of [
    { ...base, state: 'downloading', targetVersion: '2.0.0', progressPercent: -1 },
    { ...base, state: 'downloading', targetVersion: '2.0.0', progressPercent: 101 },
    {
      ...base,
      state: 'restart_confirmation',
      targetVersion: '2.0.0',
      activity: { kind: 'working', workingAgentCount: 0 },
    },
    { ...base, state: 'failed', operation: 'check', code: 'download_failed' },
    { ...base, state: 'failed', operation: 'download', code: 'check_failed' },
    // A download only fails after an update was found, so the version is known
    // and required. (Manual install carries no version at all, but that is a
    // type-level fact: schema decoding ignores excess properties.)
    { ...base, state: 'failed', operation: 'download', code: 'download_failed' },
    // The manual-install state must always say whether the last launch worked.
    // Absent is not the same fact as `null`, and a client reading it as "fine"
    // is the silent failure this field exists to prevent.
    { ...base, state: 'manual_update_required', reason: 'unsupported_installation' },
    {
      ...base,
      state: 'manual_update_required',
      reason: 'unsupported_installation',
      openFailure: 'check_failed',
    },
  ])
    assert.equal(Either.isLeft(decode(snapshot)), true, JSON.stringify(snapshot));
});
