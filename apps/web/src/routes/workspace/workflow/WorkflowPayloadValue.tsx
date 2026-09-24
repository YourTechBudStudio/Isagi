import { useMemo, useState } from 'react';

import type { WorkflowPayloadSlot } from '@isagi/contracts';

import { RuntimeApiError } from '../../../lib/runtime/errors.js';
import { useWorkflowPayloadQuery } from '../../../lib/workspace/workflow/queries.js';
import { inspectorCopy } from './copy.js';
import { formatBytes } from './format.js';

/**
 * A recorded value, and the four different things its absence can mean.
 *
 * - **Absent**: the step never produced it. The slot is `null`.
 * - **Inline**: the value travelled with the record. It may legitimately be JSON `null`, an empty
 *   string, `false` or `0`, and each of those is a value the step produced — never "nothing".
 * - **Stored**: a reference and a size. Fetched only when someone opens the tab, because a run's
 *   payloads are as large as the work was.
 * - **Unreadable**: the store has the reference but cannot serve the bytes. This is a fact about the
 *   payload store, not about the step, and it says so: the step ran, it produced the value, and
 *   nothing else about it is affected.
 *
 * The last two are the ones that must never be collapsed into each other. "Isagi cannot read this"
 * and "this was never produced" send a person to two entirely different places.
 */
export function WorkflowPayloadValue({
  runId,
  slot,
}: {
  readonly runId: number;
  readonly slot: WorkflowPayloadSlot;
}) {
  const [requested, setRequested] = useState(false);
  const stored = slot !== null && 'payloadRef' in slot ? slot : null;
  const query = useWorkflowPayloadQuery(runId, stored?.payloadRef ?? null, {
    enabled: requested && stored !== null,
  });

  if (slot === null) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">{inspectorCopy.payloadAbsent}</p>
    );
  }

  if (!('payloadRef' in slot)) {
    return <PayloadBody value={slot.inline} />;
  }

  if (query.error) {
    return <UnreadablePayload payloadRef={slot.payloadRef} error={query.error} />;
  }

  if (!requested) {
    return (
      <div className="py-1.5">
        <button
          type="button"
          onClick={() => setRequested(true)}
          className="rounded-md border border-line/35 bg-canvas/60 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:border-line/70 hover:text-fg"
        >
          {inspectorCopy.payloadLoad}
          <span className="ml-2 text-fg-subtle">{formatBytes(slot.byteSize)}</span>
        </button>
      </div>
    );
  }

  if (query.isPending) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.payloadLoading}
      </p>
    );
  }

  return <PayloadBody value={query.data?.value} />;
}

/**
 * A payload the history references and the store cannot serve.
 *
 * Red because the content is genuinely gone, and explicit about the consequence: this is a
 * degradation in reading history, not evidence that the run cannot carry on. A missing input that
 * actually blocks execution surfaces as a run failure with its own code, in the bar.
 *
 * No size is claimed after a failed read. A size that came from a record whose bytes cannot be found
 * would be the one number on screen with nothing behind it.
 */
function UnreadablePayload({
  payloadRef,
  error,
}: {
  readonly payloadRef: string;
  readonly error: unknown;
}) {
  const cause = payloadCause(error);
  return (
    <div className="max-w-xl rounded-lg border border-dashed border-error/45 bg-error/5 px-3 py-2.5">
      <p className="text-[13px] text-fg">{inspectorCopy.payloadUnavailableHeading}</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
        {cause === null
          ? inspectorCopy.payloadUnavailableFallback(payloadRef)
          : inspectorCopy.payloadUnavailableBody(payloadRef, cause)}
      </p>
    </div>
  );
}

/**
 * The runtime's own cause for an unreadable payload, when it gave one.
 *
 * Read from the structured rejection rather than from message text: `missing` and `corrupt` are
 * different problems — a file that is gone versus bytes that no longer match their hash — and a
 * person chasing either one looks in a different place. Anything else that went wrong (a dropped
 * connection, a response that did not match the contract) is not a claim about the payload at all,
 * so it falls through to the sentence that does not name a cause.
 */
function payloadCause(error: unknown): 'missing' | 'corrupt' | null {
  if (!(error instanceof RuntimeApiError)) return null;
  const data = error.apiError.code === 'workflow_rejected' ? error.apiError.data : null;
  return data !== null && data.reason === 'workflow_payload_unavailable' ? data.cause : null;
}

function PayloadBody({ value }: { readonly value: unknown }) {
  if (typeof value === 'string') return <TextValue text={value} />;
  return <JsonTree value={value} depth={0} />;
}

/**
 * Text with line numbers.
 *
 * Exported because captured evidence renders through it too: a `text/markdown` capture and a text
 * payload are the same thing on screen, and a second implementation of "text with line numbers" is
 * exactly the drift the reuse lens exists to stop.
 */
export function TextValue({ text }: { readonly text: string }) {
  const lines = useMemo(() => text.split('\n'), [text]);
  return (
    <pre className="m-0 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-muted">
      {lines.map((line, index) => (
        <span key={index}>
          <span className="inline-block w-8 select-none text-fg-subtle opacity-50">
            {String(index + 1).padStart(3, ' ')}
          </span>
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** The collapsible JSON view. Exported for the same reason `TextValue` is. */
export function JsonTree({ value, depth }: { readonly value: unknown; readonly depth: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (value === null) return <span className="font-mono text-[11.5px] text-fg-subtle">null</span>;
  if (typeof value === 'string') {
    return <span className="font-mono text-[11.5px] text-green">"{value}"</span>;
  }
  if (typeof value === 'number') {
    return <span className="font-mono text-[11.5px] text-amber">{String(value)}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="font-mono text-[11.5px] text-violet">{String(value)}</span>;
  }
  if (value === undefined) {
    return <span className="font-mono text-[11.5px] text-fg-subtle">—</span>;
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  const braces = Array.isArray(value) ? (['[', ']'] as const) : (['{', '}'] as const);

  return (
    <div className="font-mono text-[11.5px] leading-relaxed text-fg-muted">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="text-fg-subtle transition duration-micro ease-expo hover:text-fg"
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} {braces[0]}
        <span className="ml-1.5 opacity-70">
          {entries.length} {Array.isArray(value) ? 'items' : 'keys'}
        </span>
      </button>
      {open && (
        <div className="ml-1.5 border-l border-line/18 pl-4">
          {entries.map(([key, child]) => (
            <div key={key}>
              <span className="text-cyan">{key}</span>
              <span className="text-fg-subtle">: </span>
              <JsonTree value={child} depth={depth + 1} />
            </div>
          ))}
        </div>
      )}
      {open && <span className="text-fg-subtle">{braces[1]}</span>}
    </div>
  );
}
