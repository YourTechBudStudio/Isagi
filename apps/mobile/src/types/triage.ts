/**
 * Triage-related types derived from the OpenCode SDK event shapes
 * and the Isagi API contract.
 *
 * Keep these loose — the SSE payload is treated as opaque envelopes
 * and parts use passthrough schemas, so we avoid over-constraining.
 */

// ── Message types ──

export interface MessageInfo {
  readonly id: string;
  readonly sessionID: string;
  readonly role: "user" | "assistant";
  readonly [key: string]: unknown;
}

export interface MessagePart {
  readonly id: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly type: string;
  /** Present on text and reasoning parts. */
  text?: string;
  readonly [key: string]: unknown;
}

export interface Message {
  readonly info: MessageInfo;
  readonly parts: MessagePart[];
}

// ── SSE event types ──

export interface SSEEventMessageUpdated {
  readonly type: "message.updated";
  readonly properties: {
    readonly info: MessageInfo;
  };
}

export interface SSEEventPartUpdated {
  readonly type: "message.part.updated";
  readonly properties: {
    readonly part: MessagePart;
  };
}

export interface SSEEventPartDelta {
  readonly type: "message.part.delta";
  readonly properties: {
    readonly sessionID: string;
    readonly messageID: string;
    readonly partID: string;
    readonly field: string;
    readonly delta: string;
  };
}

export interface SSEEventPartRemoved {
  readonly type: "message.part.removed";
  readonly properties: {
    readonly sessionID: string;
    readonly messageID: string;
    readonly partID: string;
  };
}

export interface SSEEventSessionStatus {
  readonly type: "session.status";
  readonly properties: {
    readonly sessionID: string;
    readonly status: SessionStatus;
  };
}

export type SessionStatus =
  | { readonly type: "idle" }
  | { readonly type: "busy" }
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly message: string;
      readonly next: number;
    };

export type SSEEvent =
  | SSEEventMessageUpdated
  | SSEEventPartUpdated
  | SSEEventPartDelta
  | SSEEventPartRemoved
  | SSEEventSessionStatus;

// ── Triage list item (from user.triage.list) ──

export interface TriageListItem {
  readonly sparkId: string;
  readonly sparkTitle: string;
  readonly opencodeSessionId: string;
  readonly statusType: "idle" | "busy" | "retry";
  readonly waitingOnUser: boolean;
  readonly closedAt: number | null;
  readonly updatedAt: number;
  readonly lastValidationError: string | null;
}

// ── Triage state (from user.triage.state) ──

export interface TriageItem {
  readonly id: string;
  readonly kind: "container" | "work_item" | "derived_spark";
  readonly status: "proposed" | "approved" | "rejected" | "applied";
  readonly workstream: string;
  readonly template?: string;
  readonly title?: string;
  readonly container_ref?: string;
  readonly data?: Record<string, unknown>;
}

export interface TriageDocument {
  readonly version: 1;
  readonly items: readonly TriageItem[];
}

export interface TriageState {
  readonly sparkId: string;
  readonly opencodeSessionId: string;
  readonly triagePath: string;
  readonly rawYaml: string;
  readonly parsed: TriageDocument | null;
  readonly validationError: string | null;
}

// ── Inbox filter ──

export type TriageFilter =
  | "all"
  | "waiting"
  | "in_progress"
  | "idle"
  | "closed"
  | "error";
