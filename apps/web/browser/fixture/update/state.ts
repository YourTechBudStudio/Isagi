import type { DesktopUpdateState } from '../../../src/routes/workspace/RailUpdateFooter.js';
import type { RestartActivity } from '../../../src/routes/workspace/RestartConfirmation.js';

/**
 * Fixture state for the update surface. Production now takes these facts from
 * the host snapshot; this harness drives the same component directly, outside
 * the production bundle, so the surface stays reviewable and keyboard-testable
 * without Electron.
 */
export const INSTALLED_VERSION = '0.4.2';
export const NEXT_VERSION = '0.4.3';

export interface FixtureStateOption {
  readonly id: string;
  readonly label: string;
  readonly state: DesktopUpdateState;
}

export const STATE_OPTIONS: readonly FixtureStateOption[] = [
  { id: 'unsupported', label: 'No desktop host', state: { kind: 'unsupported' } },
  { id: 'disabled', label: 'Dev host (disabled)', state: { kind: 'disabled' } },
  { id: 'idle', label: 'Idle', state: { kind: 'idle' } },
  { id: 'checking', label: 'Checking', state: { kind: 'checking' } },
  { id: 'up-to-date', label: 'Up to date', state: { kind: 'up-to-date' } },
  {
    id: 'downloading-0',
    label: 'Downloading 0%',
    state: { kind: 'downloading', version: NEXT_VERSION, percent: 0 },
  },
  {
    id: 'downloading-38',
    label: 'Downloading 38%',
    state: { kind: 'downloading', version: NEXT_VERSION, percent: 38 },
  },
  {
    id: 'downloading-97',
    label: 'Downloading 97%',
    state: { kind: 'downloading', version: NEXT_VERSION, percent: 97 },
  },
  { id: 'ready', label: 'Ready', state: { kind: 'ready', version: NEXT_VERSION } },
  { id: 'installing', label: 'Installing', state: { kind: 'installing', version: NEXT_VERSION } },
  { id: 'check-failed', label: 'Check failed', state: { kind: 'check-failed' } },
  {
    id: 'download-failed',
    label: 'Download failed',
    state: { kind: 'download-failed', version: NEXT_VERSION },
  },
  {
    id: 'manual-required',
    label: 'Manual update (Linux)',
    state: { kind: 'manual-required', openFailed: false },
  },
  {
    id: 'manual-required-open-failed',
    label: 'Manual update, browser failed',
    state: { kind: 'manual-required', openFailed: true },
  },
];

/**
 * How long the simulated host takes to answer a restart request. The real one
 * reads agent activity over HTTP with a two-second ceiling, so the disabled
 * `Restart to update` state is genuinely observable and worth pinning.
 */
export const RESTART_LATENCY_MS = 400;

export interface FixtureActivityOption {
  readonly id: string;
  readonly label: string;
  readonly activity: RestartActivity | null;
}

/** What the simulated host will answer with once a restart request resolves. */
export const ACTIVITY_OPTIONS: readonly FixtureActivityOption[] = [
  { id: 'none', label: 'Nothing working', activity: null },
  {
    id: 'working-1',
    label: '1 agent working',
    activity: { kind: 'working', workingAgentCount: 1 },
  },
  {
    id: 'working-3',
    label: '3 agents working',
    activity: { kind: 'working', workingAgentCount: 3 },
  },
  { id: 'unknown', label: 'Activity unknown', activity: { kind: 'unknown' } },
];
