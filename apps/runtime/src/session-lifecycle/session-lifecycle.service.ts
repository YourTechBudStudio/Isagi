import { randomBytes } from 'node:crypto';

import { Context, Data, Effect, Layer } from 'effect';

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
}

export class SessionLifecycleError extends Data.TaggedError('SessionLifecycleError')<{
  readonly code:
    | 'attach_token_missing'
    | 'attach_token_invalid'
    | 'attach_token_expired'
    | 'attach_token_session_mismatch';
  readonly message: string;
}> {}

export interface SessionLifecycleService {
  readonly withRestoreLock: <A, E, R>(
    key: SessionLifecycleKey,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly issueAttachToken: (key: SessionLifecycleKey) => Effect.Effect<AttachTokenRecord>;
  readonly consumeAttachToken: (input: {
    readonly key: SessionLifecycleKey;
    readonly token: string | null;
  }) => Effect.Effect<AttachTokenRecord, SessionLifecycleError>;
  readonly revokeAttachTokens: (key: SessionLifecycleKey) => Effect.Effect<void>;
  readonly registerActiveAttachment: (input: {
    readonly key: SessionLifecycleKey;
    readonly handle: ActiveSessionAttachmentHandle;
  }) => Effect.Effect<() => void>;
  readonly hasActiveAttachment: (key: SessionLifecycleKey) => Effect.Effect<boolean>;
  readonly supersedeAttachment: (key: SessionLifecycleKey) => Effect.Effect<void>;
}

export const SessionLifecycle =
  Context.GenericTag<SessionLifecycleService>('isagi/SessionLifecycle');

export const SessionLifecycleLive = Layer.scoped(
  SessionLifecycle,
  Effect.gen(function* () {
    const semaphores = new Map<string, Effect.Semaphore>();
    const tokens = new Map<string, AttachTokenRecord>();
    const tokensBySession = new Map<string, Set<string>>();
    const activeAttachments = new Map<
      string,
      { readonly id: symbol; readonly handle: ActiveSessionAttachmentHandle }
    >();

    const service: SessionLifecycleService = {
      withRestoreLock: (key, effect) =>
        Effect.gen(function* () {
          const semaphore = yield* semaphoreForKey(semaphores, key);
          return yield* semaphore.withPermits(1)(effect);
        }),
      issueAttachToken: (key) =>
        Effect.sync(() => {
          revokeTokensForKey(tokens, tokensBySession, key);
          const now = Date.now();
          const record = {
            token: randomBytes(32).toString('base64url'),
            key,
            issuedAt: now,
            expiresAt: now + attachTokenTtlMs,
          } satisfies AttachTokenRecord;
          tokens.set(record.token, record);
          const keyId = sessionKeyId(key);
          tokensBySession.set(keyId, new Set([record.token]));
          return record;
        }),
      consumeAttachToken: (input) =>
        Effect.gen(function* () {
          if (!input.token) {
            return yield* Effect.fail(
              new SessionLifecycleError({
                code: 'attach_token_missing',
                message: 'Attach token is required.',
              }),
            );
          }
          const record = tokens.get(input.token);
          if (!record) {
            return yield* Effect.fail(
              new SessionLifecycleError({
                code: 'attach_token_invalid',
                message: 'Attach token was not recognized.',
              }),
            );
          }
          deleteToken(tokens, tokensBySession, record);
          if (!sameSessionKey(record.key, input.key)) {
            return yield* Effect.fail(
              new SessionLifecycleError({
                code: 'attach_token_session_mismatch',
                message: 'Attach token does not match this session.',
              }),
            );
          }
          if (record.expiresAt <= Date.now()) {
            return yield* Effect.fail(
              new SessionLifecycleError({
                code: 'attach_token_expired',
                message: 'Attach token expired.',
              }),
            );
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
          activeAttachments.set(keyId, { id, handle: input.handle });
          return () => {
            if (activeAttachments.get(keyId)?.id === id) activeAttachments.delete(keyId);
          };
        }),
      hasActiveAttachment: (key) => Effect.sync(() => activeAttachments.has(sessionKeyId(key))),
      supersedeAttachment: (key) =>
        Effect.gen(function* () {
          yield* service.revokeAttachTokens(key);
          const keyId = sessionKeyId(key);
          const active = activeAttachments.get(keyId);
          if (!active) return;
          activeAttachments.delete(keyId);
          yield* active.handle.moved;
        }),
    };

    return yield* Effect.acquireRelease(Effect.succeed(service), () =>
      Effect.sync(() => {
        semaphores.clear();
        tokens.clear();
        tokensBySession.clear();
        activeAttachments.clear();
      }),
    );
  }),
);

function semaphoreForKey(semaphores: Map<string, Effect.Semaphore>, key: SessionLifecycleKey) {
  return Effect.gen(function* () {
    const keyId = sessionKeyId(key);
    const existing = semaphores.get(keyId);
    if (existing) return existing;
    const semaphore = yield* Effect.makeSemaphore(1);
    semaphores.set(keyId, semaphore);
    return semaphore;
  });
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
