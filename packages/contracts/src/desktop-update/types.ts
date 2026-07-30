import { Schema } from 'effect';

export const DESKTOP_UPDATE_PROTOCOL_VERSION = 1 as const;

const snapshotBase = {
  protocolVersion: Schema.Literal(DESKTOP_UPDATE_PROTOCOL_VERSION),
  revision: Schema.NonNegativeInt,
  installedVersion: Schema.String,
};

export const desktopUpdateFailureCodeSchema = Schema.Literal(
  'check_failed',
  'download_failed',
  'download_page_open_failed',
);

/** Download progress is always normalized to a percentage of the target artifact. */
const progressPercentSchema = Schema.Number.pipe(Schema.between(0, 100));

/** Restart confirmation is only surfaced when at least one agent is still working. */
const workingAgentCountSchema = Schema.NonNegativeInt.pipe(Schema.positive());

export const desktopUpdateSnapshotSchema = Schema.Union(
  Schema.Struct({ ...snapshotBase, state: Schema.Literal('disabled') }),
  Schema.Struct({ ...snapshotBase, state: Schema.Literal('idle') }),
  Schema.Struct({ ...snapshotBase, state: Schema.Literal('checking') }),
  Schema.Struct({ ...snapshotBase, state: Schema.Literal('up_to_date') }),
  Schema.Struct({
    ...snapshotBase,
    state: Schema.Literal('downloading'),
    targetVersion: Schema.String,
    progressPercent: progressPercentSchema,
  }),
  Schema.Struct({
    ...snapshotBase,
    state: Schema.Literal('ready'),
    targetVersion: Schema.String,
  }),
  Schema.Struct({
    ...snapshotBase,
    state: Schema.Literal('restart_confirmation'),
    targetVersion: Schema.String,
    activity: Schema.Union(
      Schema.Struct({
        kind: Schema.Literal('working'),
        workingAgentCount: workingAgentCountSchema,
      }),
      Schema.Struct({ kind: Schema.Literal('unknown') }),
    ),
  }),
  Schema.Struct({
    ...snapshotBase,
    state: Schema.Literal('installing'),
    targetVersion: Schema.String,
  }),
  /**
   * A build that cannot replace itself. It carries no target version: this state
   * is decided during composition, before any provider is contacted, so no
   * available version is known and claiming one would be a guess.
   *
   * `openFailure` reports the last attempt to open the release download page.
   * The remedy stays the same state either way — the installation is still
   * manual and the action is still worth pressing again — so the failure is an
   * overlay on it rather than a state of its own. It is carried here because
   * this is the only place the client can learn that a user-owned action did
   * nothing: the browser launch produces no updater event.
   */
  Schema.Struct({
    ...snapshotBase,
    state: Schema.Literal('manual_update_required'),
    reason: Schema.Literal('unsupported_installation'),
    openFailure: Schema.NullOr(Schema.Literal('download_page_open_failed')),
  }),
  Schema.Struct({
    ...snapshotBase,
    state: Schema.Literal('failed'),
    operation: Schema.Literal('check'),
    code: Schema.Literal('check_failed'),
  }),
  /**
   * A download only fails after an update was found, so the target version is
   * known and is carried. It stays a plain string rather than a nonempty one: a
   * provider event that omits the version should degrade the sentence shown to
   * the user, not make the snapshot undecodable.
   */
  Schema.Struct({
    ...snapshotBase,
    state: Schema.Literal('failed'),
    operation: Schema.Literal('download'),
    code: Schema.Literal('download_failed'),
    targetVersion: Schema.String,
  }),
);

export const desktopUpdateIntentSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal('check_for_updates') }),
  Schema.Struct({ type: Schema.Literal('request_restart') }),
  Schema.Struct({ type: Schema.Literal('confirm_restart') }),
  Schema.Struct({ type: Schema.Literal('cancel_restart') }),
  Schema.Struct({ type: Schema.Literal('open_download_page') }),
);

export type DesktopUpdateFailureCode = typeof desktopUpdateFailureCodeSchema.Type;
export type DesktopUpdateSnapshot = typeof desktopUpdateSnapshotSchema.Type;
export type DesktopUpdateIntent = typeof desktopUpdateIntentSchema.Type;
