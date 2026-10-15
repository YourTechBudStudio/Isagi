import { randomBytes } from 'node:crypto';

import { Context, Data, Effect, Layer } from 'effect';

import type { Incarnation } from '../../harnesses/index.js';
import { EntityLock } from '../../platform/locks/index.js';

const attachTokenTtlMs = 5 * 60 * 1000;

export type SessionLifecycleKey =
  | { readonly kind: 'agent_session'; readonly sessionId: number }
  | { readonly kind: 'terminal_session'; readonly sessionId: number };

export interface ActiveSessionAttachmentHandle {
  readonly moved: Effect.Effect<void>;
}

export interface AttachTokenRecord {
  readonly token: string;
  readonly key: SessionLifecycleKey;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /**
   * The live incarnation an automatic re-attach claimed. The attach it admits may join only that
   * process, never launch one; `null` admits the ordinary attach, which may.
   */
  readonly expectedIncarnation: Incarnation | null;
}

export class SessionLifecycleError extends Data.TaggedError('SessionLifecycleError')<{
  readonly code:
    | 'attach_token_missing'
    | 'attach_token_invalid'
    | 'attach_token_expired'
    | 'attach_token_session_mismatch'
    /** An automatic re-attach found another attachment already streaming the process it named. */
    | 'session_already_attached'
    /** An automatic re-attach's process stopped being the session's live one before it attached. */
    | 'process_incarnation_stale';
  readonly message: string;
}> {}

const make = Effect.gen(function* () {
  // Restore exclusion is the generic per-entity lock, shared with every other
  // domain that serializes on a durable entity. The attach-token and
  // attachment state below stays private to sessions: only the mutual
  // exclusion is common machinery.
  const locks = yield* EntityLock;
  const tokens = new Map<string, AttachTokenRecord>();
  const tokensBySession = new Map<string, Set<string>>();
  const activeAttachments = new Map<
    string,
    {
      readonly id: symbol;
      readonly handle: ActiveSessionAttachmentHandle;
      readonly incarnation: Incarnation | null;
    }
  >();

  const supersede = Effect.fnUntraced(function* (key: SessionLifecycleKey) {
    revokeTokensForKey(tokens, tokensBySession, key);
    const keyId = sessionKeyId(key);
    const active = activeAttachments.get(keyId);
    if (!active) return;
    activeAttachments.delete(keyId);
    yield* active.handle.moved;
  });

  const service = SessionLifecycle.of({
    withRestoreLock: (key, effect) =>
      locks.withLock({ kind: key.kind, id: key.sessionId }, () => effect),
    issueAttachToken: (key, options) =>
      Effect.sync(() => {
        const now = Date.now();
        const keyId = sessionKeyId(key);
        const sessionTokens = tokensBySession.get(keyId) ?? new Set<string>();
        // Sweep this session's already-expired tokens on each issue so dead tokens
        // don't pile up across issues (they are otherwise only dropped on
        // consume/revoke). This bounds growth to tokens issued within one TTL
        // window rather than a fixed cap; live tokens stay valid because concurrent
        // attach attempts are intentionally kept independent.
        for (const token of sessionTokens) {
          const existing = tokens.get(token);
          if (!existing || existing.expiresAt <= now) {
            tokens.delete(token);
            sessionTokens.delete(token);
          }
        }
        const record = {
          token: randomBytes(32).toString('base64url'),
          key,
          issuedAt: now,
          expiresAt: now + attachTokenTtlMs,
          expectedIncarnation: options?.expectedIncarnation ?? null,
        } satisfies AttachTokenRecord;
        tokens.set(record.token, record);
        sessionTokens.add(record.token);
        tokensBySession.set(keyId, sessionTokens);
        return record;
      }),
    consumeAttachToken: Effect.fn('SessionLifecycle.consumeAttachToken')(function* (input) {
      if (!input.token) {
        return yield* new SessionLifecycleError({
          code: 'attach_token_missing',
          message: 'Attach token is required.',
        });
      }
      const record = tokens.get(input.token);
      if (!record) {
        return yield* new SessionLifecycleError({
          code: 'attach_token_invalid',
          message: 'Attach token was not recognized.',
        });
      }
      deleteToken(tokens, tokensBySession, record);
      if (!sameSessionKey(record.key, input.key)) {
        return yield* new SessionLifecycleError({
          code: 'attach_token_session_mismatch',
          message: 'Attach token does not match this session.',
        });
      }
      if (record.expiresAt <= Date.now()) {
        return yield* new SessionLifecycleError({
          code: 'attach_token_expired',
          message: 'Attach token expired.',
        });
      }
      return record;
    }),
    revokeAttachTokens: (key) =>
      Effect.sync(() => {
        revokeTokensForKey(tokens, tokensBySession, key);
      }),
    registerActiveAttachment: (input) =>
      Effect.sync(() => {
        const keyId = sessionKeyId(input.key);
        const id = Symbol(`session-attachment-${keyId}`);
        activeAttachments.set(keyId, {
          id,
          handle: input.handle,
          incarnation: input.incarnation,
        });
        return () => {
          if (activeAttachments.get(keyId)?.id === id) activeAttachments.delete(keyId);
        };
      }),
    hasActiveAttachment: (key) => Effect.sync(() => activeAttachments.has(sessionKeyId(key))),
    supersedeAttachment: Effect.fn('SessionLifecycle.supersedeAttachment')(function* (key) {
      yield* supersede(key);
    }),
    displaceObsoleteAttachment: Effect.fn('SessionLifecycle.displaceObsoleteAttachment')(
      function* (key, incarnation) {
        // Checked and displaced with no suspension between, so an attachment that registers
        // meanwhile is either seen here or registers after, displacing this one as usual.
        const keyId = sessionKeyId(key);
        const active = activeAttachments.get(keyId);
        if (active?.incarnation === incarnation)
          return yield* new SessionLifecycleError({
            code: 'session_already_attached',
            message: `Another attachment already streams ${incarnation}.`,
          });
        // Unlike a takeover, outstanding attach tokens are left alone: one may be an explicit
        // Reconnect whose socket has not arrived yet, and it must still win when it does.
        if (!active) return;
        activeAttachments.delete(keyId);
        yield* active.handle.moved;
      },
    ),
  });

  return yield* Effect.acquireRelease(Effect.succeed(service), () =>
    Effect.sync(() => {
      tokens.clear();
      tokensBySession.clear();
      activeAttachments.clear();
    }),
  );
});

export class SessionLifecycle extends Context.Service<
  SessionLifecycle,
  {
    readonly withRestoreLock: <A, E, R>(
      key: SessionLifecycleKey,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly issueAttachToken: (
      key: SessionLifecycleKey,
      options?: { readonly expectedIncarnation?: Incarnation | undefined },
    ) => Effect.Effect<AttachTokenRecord>;
    readonly consumeAttachToken: (input: {
      readonly key: SessionLifecycleKey;
      readonly token: string | null;
    }) => Effect.Effect<AttachTokenRecord, SessionLifecycleError>;
    readonly revokeAttachTokens: (key: SessionLifecycleKey) => Effect.Effect<void>;
    readonly registerActiveAttachment: (input: {
      readonly key: SessionLifecycleKey;
      readonly handle: ActiveSessionAttachmentHandle;
      /** The process this attachment streams, so an automatic re-attach can leave its holder be. */
      readonly incarnation: Incarnation | null;
    }) => Effect.Effect<() => void>;
    readonly hasActiveAttachment: (key: SessionLifecycleKey) => Effect.Effect<boolean>;
    readonly supersedeAttachment: (key: SessionLifecycleKey) => Effect.Effect<void>;
    /**
     * An automatic rejoin's narrower `supersedeAttachment`. It displaces only an attached socket
     * to an older process, and refuses with `session_already_attached` rather than take
     * `incarnation` from the attachment already streaming it (ADR 0006: no automatic take-back).
     * It never revokes attach tokens, so a pending explicit attach (Reconnect, Resume) still lands.
     */
    readonly displaceObsoleteAttachment: (
      key: SessionLifecycleKey,
      incarnation: Incarnation,
    ) => Effect.Effect<void, SessionLifecycleError>;
  }
>()('isagi/runtime/environment/SessionLifecycle') {
  static readonly layerNoDeps = Layer.effect(SessionLifecycle, make);
  static readonly layer = SessionLifecycle.layerNoDeps.pipe(Layer.provide(EntityLock.layer));
}

function revokeTokensForKey(
  tokens: Map<string, AttachTokenRecord>,
  tokensBySession: Map<string, Set<string>>,
  key: SessionLifecycleKey,
) {
  const keyId = sessionKeyId(key);
  const sessionTokens = tokensBySession.get(keyId);
  if (!sessionTokens) return;
  for (const token of sessionTokens) tokens.delete(token);
  tokensBySession.delete(keyId);
}

function deleteToken(
  tokens: Map<string, AttachTokenRecord>,
  tokensBySession: Map<string, Set<string>>,
  record: AttachTokenRecord,
) {
  tokens.delete(record.token);
  const keyId = sessionKeyId(record.key);
  const sessionTokens = tokensBySession.get(keyId);
  sessionTokens?.delete(record.token);
  if (sessionTokens?.size === 0) tokensBySession.delete(keyId);
}

function sameSessionKey(left: SessionLifecycleKey, right: SessionLifecycleKey) {
  return left.kind === right.kind && left.sessionId === right.sessionId;
}

export function sessionKeyId(key: SessionLifecycleKey) {
  return `${key.kind}:${key.sessionId}`;
}
