/**
 * Everything `ctx.captureEvidence` can refuse before it has recorded anything.
 *
 * Pure, and pure on purpose: this whole module runs *before* the call position is claimed, so an
 * author error leaves no `intended` row behind to be reconciled and explained. Nothing here touches
 * a filesystem — a `file` capture is only reduced to a normalised relative path, and whether that
 * path resolves to real bytes is a question for the dispatch branch alone.
 *
 * Every limit rejects rather than truncating. A silently shortened title would make the recorded
 * identity differ from what the author wrote, and the next Retry would refuse the unchanged
 * callback as a changed request — a failure with no visible cause.
 */

import type {
  EvidenceCaptureInput,
  EvidenceLabels,
  EvidenceSource,
} from '@yourtechbudstudio/isagi-workflow-sdk';

import type { NormalizedEvidenceSource, NormalizedRequest } from '../operations/correlation.js';
import { canonicalBytes, UnserializableValueError } from '../state/serializable.js';
import { isMediaType, mediaTypeForExtension } from './media-types.js';
import { normalizeWorktreeRelativePath } from './paths.js';

/**
 * The closed set of reasons a capture is refused, carried as `detail.reason` on the rejection.
 *
 * `content_unavailable` is the only member not raised here: it belongs to the filesystem and
 * publication stages, which run after the position is claimed. It lives in this union anyway so
 * there is one place to read what an `evidence_capture_rejected` failure can say.
 */
export type EvidenceRejectionReason =
  | 'invalid_title'
  | 'invalid_role'
  | 'invalid_labels'
  | 'invalid_source'
  /** The `content` itself is absent, or not the shape its `kind` declares. */
  | 'invalid_content'
  | 'invalid_media_type'
  | 'unserializable_json'
  | 'path_outside_worktree'
  | 'path_not_found'
  | 'not_a_file'
  | 'content_unavailable';

export interface NormalizedCapture {
  readonly request: Extract<NormalizedRequest, { capability: 'capture_evidence' }>;
  /** Bytes already in hand, or the worktree-relative path they must be streamed from. */
  readonly body: { kind: 'buffer'; bytes: Buffer } | { kind: 'file'; relativePath: string };
}

export interface EvidenceRejection {
  readonly ok: false;
  readonly reason: EvidenceRejectionReason;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type NormalizeCaptureResult =
  | { readonly ok: true; readonly value: NormalizedCapture }
  | EvidenceRejection;

/** A step that either produced its part of the normalized capture, or refused the whole call. */
type Checked<T> = { readonly ok: true; readonly value: T } | EvidenceRejection;

const maxTitleLength = 512;
const maxLabelEntries = 32;
const maxLabelKeyLength = 64;
const maxLabelValueLength = 1024;

/** Same grammar as a workflow identifier, so a role is a URL query value and an index key as-is. */
const rolePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const reject = (
  reason: EvidenceRejectionReason,
  detail: Readonly<Record<string, unknown>> = {},
): EvidenceRejection => ({ ok: false, reason, detail });

function normalizeLabels(value: unknown): Checked<EvidenceLabels | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return reject('invalid_labels', { expected: 'a flat object of scalars' });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxLabelEntries) {
    return reject('invalid_labels', { entries: entries.length, limit: maxLabelEntries });
  }
  const labels: Record<string, string | number | boolean> = {};
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > maxLabelKeyLength) {
      return reject('invalid_labels', { key, limit: maxLabelKeyLength });
    }
    // The colon is what the list filter splits a `label=key:value` query on, so a key carrying one
    // would be unfilterable — recorded but unreachable, which is worse than refused.
    if (key.includes(':')) return reject('invalid_labels', { key, disallowed: ':' });
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused.
    if (/[\u0000-\u001f\u007f]/.test(key)) return reject('invalid_labels', { key });
    if (typeof entry === 'boolean') {
      labels[key] = entry;
    } else if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return reject('invalid_labels', { key, value: String(entry) });
      labels[key] = entry;
    } else if (typeof entry === 'string') {
      if (entry.length > maxLabelValueLength) {
        return reject('invalid_labels', { key, length: entry.length, limit: maxLabelValueLength });
      }
      labels[key] = entry;
    } else {
      return reject('invalid_labels', { key, type: entry === null ? 'null' : typeof entry });
    }
  }
  // An empty object is no labels. Both already store as `{}`, so keeping them distinct in the
  // fingerprint would mean an author tidying `labels: {}` out of a call is refused as
  // `operation_request_changed` on the next Retry, with nothing in the record to explain why.
  return { ok: true, value: entries.length === 0 ? null : labels };
}

/**
 * Project the author's source down to the fields that may enter a durable call identity.
 *
 * Extras are dropped, not refused. Handing back the `AgentSessionHandle` that `spawnAgentSession`
 * returned is the *expected* authoring shape, and its `paneId` is environment-lifetime data that
 * must not decide whether a Retry can repair a run; structural typing also means an author could
 * not be told what the extra field was. So the runtime takes what it needs and says nothing.
 */
function normalizeSource(value: unknown): Checked<NormalizedEvidenceSource | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'object') return reject('invalid_source', { type: typeof value });
  const source = value as EvidenceSource;
  switch (source.kind) {
    case 'agent_turn': {
      const target = source.target as Partial<{ agentSessionId: unknown; sentAt: unknown }> | null;
      if (typeof target !== 'object' || target === null) {
        return reject('invalid_source', { kind: 'agent_turn', missing: 'target' });
      }
      if (!Number.isInteger(target.agentSessionId)) {
        return reject('invalid_source', { kind: 'agent_turn', field: 'agentSessionId' });
      }
      if (typeof target.sentAt !== 'string' || target.sentAt.length === 0) {
        return reject('invalid_source', { kind: 'agent_turn', field: 'sentAt' });
      }
      return {
        ok: true,
        value: {
          kind: 'agent_turn',
          agentSessionId: target.agentSessionId as number,
          sentAt: target.sentAt,
        },
      };
    }
    case 'headless_operation': {
      const operation = source.operation as Partial<{ operationId: unknown }> | null;
      if (typeof operation !== 'object' || operation === null) {
        return reject('invalid_source', { kind: 'headless_operation', missing: 'operation' });
      }
      if (typeof operation.operationId !== 'string' || operation.operationId.length === 0) {
        return reject('invalid_source', { kind: 'headless_operation', field: 'operationId' });
      }
      return {
        ok: true,
        value: { kind: 'headless_operation', operationId: operation.operationId },
      };
    }
    case 'agent_session': {
      if (!Number.isInteger(source.agentSessionId)) {
        return reject('invalid_source', { kind: 'agent_session', field: 'agentSessionId' });
      }
      return { ok: true, value: { kind: 'agent_session', agentSessionId: source.agentSessionId } };
    }
    default:
      return reject('invalid_source', {
        kind: (source as { kind?: unknown }).kind ?? null,
      });
  }
}

/**
 * Check order is title, role, labels, source, then content.
 *
 * Fixed rather than incidental: an author fixing one call at a time should meet the same complaint
 * in the same order on every run, and the first four are cheap identity checks while the content
 * branch may canonicalise a large value.
 */
export function normalizeCaptureInput(input: unknown): NormalizeCaptureResult {
  if (typeof input !== 'object' || input === null) {
    return reject('invalid_content', { expected: 'an EvidenceCaptureInput object' });
  }
  const candidate = input as Partial<EvidenceCaptureInput>;

  if (typeof candidate.title !== 'string')
    return reject('invalid_title', { type: typeof candidate.title });
  const title = candidate.title.trim();
  if (title.length === 0) return reject('invalid_title', { note: 'empty after trim' });
  if (title.length > maxTitleLength) {
    return reject('invalid_title', { length: title.length, limit: maxTitleLength });
  }

  if (typeof candidate.role !== 'string' || !rolePattern.test(candidate.role)) {
    return reject('invalid_role', { role: candidate.role ?? null, pattern: rolePattern.source });
  }
  const role = candidate.role;

  const labels = normalizeLabels(candidate.labels);
  if (!labels.ok) return labels;

  const source = normalizeSource(candidate.source);
  if (!source.ok) return source;

  const content = candidate.content;
  if (typeof content !== 'object' || content === null) {
    return reject('invalid_content', { note: 'no content given' });
  }

  const base = { capability: 'capture_evidence', title, role, labels: labels.value } as const;

  switch (content.kind) {
    case 'text': {
      if (typeof content.text !== 'string') {
        return reject('invalid_content', { kind: 'text', field: 'text' });
      }
      const mediaType = content.mediaType ?? 'text/plain';
      if (!isMediaType(mediaType)) return reject('invalid_media_type', { mediaType });
      return {
        ok: true,
        value: {
          request: {
            ...base,
            contentKind: 'text',
            mediaType,
            sourcePath: null,
            source: source.value,
          },
          body: { kind: 'buffer', bytes: Buffer.from(content.text, 'utf8') },
        },
      };
    }
    case 'json': {
      let bytes: Buffer;
      try {
        bytes = canonicalBytes(content.value);
      } catch (cause) {
        return reject('unserializable_json', {
          message: cause instanceof UnserializableValueError ? cause.message : String(cause),
        });
      }
      return {
        ok: true,
        value: {
          request: {
            ...base,
            contentKind: 'json',
            mediaType: 'application/json',
            sourcePath: null,
            source: source.value,
          },
          body: { kind: 'buffer', bytes },
        },
      };
    }
    case 'bytes': {
      // `instanceof Uint8Array`, not `ArrayBuffer.isView`, because the guard must accept exactly
      // what the copy below can carry. `ArrayBuffer.isView` also admits a `Float64Array` or a
      // `DataView`, which `Buffer.from` reads as an array-like of numbers rather than as raw bytes:
      // a 16-byte `Float64Array` would become 2 truncated bytes and a `DataView` would become
      // empty — silently, with a `byte_size` column agreeing with the wrong content. Recording
      // something other than what was captured is the one failure this module exists to prevent, so
      // the wider input is refused rather than coerced. `Buffer` subclasses `Uint8Array` and passes.
      if (!(content.bytes instanceof Uint8Array)) {
        return reject('invalid_content', {
          kind: 'bytes',
          field: 'bytes',
          expected: 'a Uint8Array',
        });
      }
      // Required, not defaulted: bytes carry no name to guess from, and `application/octet-stream`
      // chosen silently would leave every rendered image undisplayable with no sign of why.
      if (!isMediaType(content.mediaType)) {
        return reject('invalid_media_type', { mediaType: content.mediaType ?? null });
      }
      return {
        ok: true,
        value: {
          request: {
            ...base,
            contentKind: 'bytes',
            mediaType: content.mediaType,
            sourcePath: null,
            source: source.value,
          },
          body: {
            // A copy, not a view over the author's array. Publication happens later in the effect,
            // and a module whose whole thesis is "keep this exact thing" must not capture bytes
            // that the caller can still change out from under it.
            kind: 'buffer',
            bytes: Buffer.from(content.bytes),
          },
        },
      };
    }
    case 'file': {
      // Not `path_outside_worktree`: nothing was named, so nothing escaped anywhere. Telling an
      // author who passed `undefined` that their path left the worktree sends them to the wrong
      // problem entirely.
      if (typeof content.path !== 'string') {
        return reject('invalid_content', { kind: 'file', field: 'path' });
      }
      const normalized = normalizeWorktreeRelativePath(content.path);
      if (!normalized.ok) return reject(normalized.reason, { path: content.path });
      const mediaType = content.mediaType ?? mediaTypeForExtension(normalized.path);
      if (!isMediaType(mediaType)) return reject('invalid_media_type', { mediaType });
      return {
        ok: true,
        value: {
          request: {
            ...base,
            contentKind: 'file',
            mediaType,
            sourcePath: normalized.path,
            source: source.value,
          },
          body: { kind: 'file', relativePath: normalized.path },
        },
      };
    }
    default:
      return reject('invalid_content', {
        contentKind: (content as { kind?: unknown }).kind ?? null,
      });
  }
}
