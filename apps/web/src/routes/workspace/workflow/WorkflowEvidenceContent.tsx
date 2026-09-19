import { useEffect, useRef, useState } from 'react';

import type { WorkflowEvidenceDto } from '@isagi/contracts';

import { RuntimeApiError } from '../../../lib/runtime/errors.js';
import { contentPresentation, previewCapBytes } from '../../../lib/workspace/workflow/evidence.js';
import { useWorkflowEvidenceContent } from '../../../lib/workspace/workflow/queries.js';
import { inspectorCopy } from './copy.js';
import { formatBytes } from './format.js';
import { JsonTree, TextValue } from './WorkflowPayloadValue.js';

/**
 * The bytes a capture kept, and the several different things "you cannot see them" can mean.
 *
 * One component, used by the Evidence tab's detail pane and by the dock's `ev<n> · content` tab.
 * A second renderer would be two places for the rule that matters most here: that **"Isagi cannot
 * read this" and "this was never produced" must never collapse into each other.** Evidence only
 * ever exists because a capture committed, so the second is not even a state this surface has —
 * which makes it all the more important that the first says exactly what it means and leaves the
 * record's own metadata standing beside it.
 *
 * What is fetched, and when, is deliberate. A preview at or under the cap loads on selection; a
 * larger one waits for a click, exactly as a stored payload does one pane over. Arrow-keying down a
 * tree must not pull a megabyte per row — the route serves whole objects and has no ranges, so the
 * 256 KB cap bounds what is *rendered*, never what is transferred.
 */
export function WorkflowEvidenceContent({
  runId,
  record,
  compact = false,
}: {
  readonly runId: number;
  readonly record: WorkflowEvidenceDto;
  /** The dock's Data tab is narrow; the detail pane is not. Only sizing differs. */
  readonly compact?: boolean;
}) {
  const presentation = contentPresentation(record.content.mediaType);
  const previewable = presentation !== 'download';
  const withinCap = record.content.byteSize <= previewCapBytes;
  const [requested, setRequested] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [htmlMode, setHtmlMode] = useState<'source' | 'render'>('source');

  // A new record is a new question. Without this the previous record's "shown" state would carry
  // over and auto-fetch something the person never asked for.
  useEffect(() => {
    setRequested(false);
    setDownloading(false);
    setHtmlMode('source');
  }, [record.evidenceKey]);

  const wanted = downloading || requested || (previewable && withinCap);
  const query = useWorkflowEvidenceContent(runId, record.evidenceKey, { enabled: wanted });
  const blob = query.data ?? null;

  useDownloadWhenReady({
    armed: downloading,
    blob,
    fileName: downloadFileName(record),
    onDone: () => setDownloading(false),
  });

  const download = (
    <DownloadButton
      byteSize={record.content.byteSize}
      pending={downloading && blob === null && query.error === undefined}
      onClick={() => setDownloading(true)}
    />
  );

  if (query.error) {
    return <UnreadableEvidence contentRef={record.content.contentRef} error={query.error} />;
  }

  if (!previewable) {
    return (
      <p className="flex flex-wrap items-center gap-2 py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.evidenceDownloadOnly(record.content.mediaType)}
        {download}
      </p>
    );
  }

  if (!wanted) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-1.5">
        <button
          type="button"
          onClick={() => setRequested(true)}
          className="rounded-md border border-line/35 bg-canvas/60 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:border-line/70 hover:text-fg"
        >
          {inspectorCopy.evidenceContentLoad}
          <span className="ml-2 text-fg-subtle">{formatBytes(record.content.byteSize)}</span>
        </button>
        {download}
      </div>
    );
  }

  if (blob === null) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.evidenceContentLoading}
      </p>
    );
  }

  return (
    <div>
      <EvidenceBody
        presentation={presentation}
        blob={blob}
        record={record}
        compact={compact}
        htmlMode={htmlMode}
        onHtmlMode={setHtmlMode}
      />
      <div className="mt-2">{download}</div>
    </div>
  );
}

function EvidenceBody({
  presentation,
  blob,
  record,
  compact,
  htmlMode,
  onHtmlMode,
}: {
  readonly presentation: 'text' | 'json' | 'image' | 'html';
  readonly blob: Blob;
  readonly record: WorkflowEvidenceDto;
  readonly compact: boolean;
  readonly htmlMode: 'source' | 'render';
  readonly onHtmlMode: (mode: 'source' | 'render') => void;
}) {
  if (presentation === 'image') return <EvidenceImage blob={blob} record={record} />;
  if (presentation === 'html') {
    return <EvidenceHtml blob={blob} compact={compact} mode={htmlMode} onMode={onHtmlMode} />;
  }
  return <EvidenceTextual blob={blob} json={presentation === 'json'} />;
}

/**
 * Text and JSON, capped at 256 KB of *bytes*.
 *
 * The cap is applied to the slice that is decoded, not to the decoded string, so a pathological
 * multi-byte document cannot slip past it. JSON over the cap falls back to the text view: a
 * truncated document does not parse, and a tree built from half a file would be a lie about its
 * shape. The same fallback covers bytes that claim `application/json` and are not.
 */
function EvidenceTextual({ blob, json }: { readonly blob: Blob; readonly json: boolean }) {
  const truncated = blob.size > previewCapBytes;
  const text = useBlobText(blob);

  if (text === null) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.evidenceContentLoading}
      </p>
    );
  }

  const parsed = json && !truncated ? parseJson(text) : null;
  return (
    <>
      {parsed === null ? <TextValue text={text} /> : <JsonTree value={parsed.value} depth={0} />}
      {truncated && (
        <p className="mt-2 font-mono text-[11px] text-amber">{inspectorCopy.evidenceTruncated}</p>
      )}
    </>
  );
}

function EvidenceImage({
  blob,
  record,
}: {
  readonly blob: Blob;
  readonly record: WorkflowEvidenceDto;
}) {
  const url = useObjectUrl(blob);
  if (url === null) return null;
  return (
    <figure className="m-0">
      <span className="inline-block rounded-lg border border-line/30 bg-scrim/40 p-1.5">
        <img src={url} alt={record.title} className="block max-w-full rounded" />
      </span>
      <figcaption className="mt-1.5 font-mono text-[11px] text-fg-subtle">
        {record.content.mediaType} · {formatBytes(record.content.byteSize)}
      </figcaption>
    </figure>
  );
}

/**
 * HTML, shown as source until someone asks for a picture.
 *
 * The empty `sandbox` attribute is the control, not the CSP: no scripts, no same-origin, no forms,
 * no top-level navigation. The desktop preload exposes its bridge only in the main frame, so even a
 * hypothetical escape observes no `window.isagi` at all. Nothing the document links to resolves,
 * and the hint says so rather than leaving a person to wonder why a stylesheet did not apply.
 *
 * Source is the default because captured HTML is evidence about what a step produced, and rendering
 * it is a second, opt-in question.
 */
function EvidenceHtml({
  blob,
  compact,
  mode,
  onMode,
}: {
  readonly blob: Blob;
  readonly compact: boolean;
  readonly mode: 'source' | 'render';
  readonly onMode: (mode: 'source' | 'render') => void;
}) {
  const truncated = blob.size > previewCapBytes;
  const source = useBlobText(blob);
  const full = useBlobText(mode === 'render' ? blob : null, { whole: true });

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="flex gap-px rounded-lg border border-line/28 bg-elevated/70 p-px">
          {(['source', 'render'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              data-html-mode={value}
              onClick={() => onMode(value)}
              className={`rounded-md px-2.5 py-0.5 font-mono text-[11px] transition duration-micro ease-expo ${
                mode === value ? 'bg-cyan/14 text-fg' : 'text-fg-subtle hover:text-fg'
              }`}
            >
              {value === 'source'
                ? inspectorCopy.evidenceHtmlSource
                : inspectorCopy.evidenceHtmlRender}
            </button>
          ))}
        </div>
        <span className="font-mono text-[11px] text-fg-subtle">
          {mode === 'source'
            ? inspectorCopy.evidenceHtmlSourceHint
            : inspectorCopy.evidenceHtmlRenderHint}
        </span>
      </div>
      {mode === 'source' ? (
        source === null ? (
          <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
            {inspectorCopy.evidenceContentLoading}
          </p>
        ) : (
          <>
            <TextValue text={source} />
            {truncated && (
              <p className="mt-2 font-mono text-[11px] text-amber">
                {inspectorCopy.evidenceTruncated}
              </p>
            )}
          </>
        )
      ) : full === null ? (
        <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
          {inspectorCopy.evidenceContentLoading}
        </p>
      ) : (
        <iframe
          title={inspectorCopy.evidenceHtmlRender}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={full}
          className="w-full rounded-lg border border-line/30 bg-white"
          style={{ height: compact ? 240 : 320 }}
        />
      )}
    </>
  );
}

/**
 * Bytes the record references and the content store cannot serve.
 *
 * Only ever rendered beside the record's own fields, never in place of them. A capture that
 * committed is a durable fact about the run; losing its bytes degrades what can be read back and
 * changes nothing about what happened.
 */
function UnreadableEvidence({
  contentRef,
  error,
}: {
  readonly contentRef: string;
  readonly error: unknown;
}) {
  const cause = evidenceContentCause(error);
  return (
    <div className="max-w-xl rounded-lg border border-dashed border-error/45 bg-error/5 px-3 py-2.5">
      <p className="text-[13px] text-fg">{inspectorCopy.evidenceUnavailableHeading}</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
        {cause === null
          ? inspectorCopy.evidenceUnavailableFallback(contentRef)
          : inspectorCopy.evidenceUnavailableBody(contentRef, cause)}
      </p>
    </div>
  );
}

/**
 * The runtime's own cause, when it gave one.
 *
 * Read from the structured rejection rather than from message text, for the reason the payload
 * viewer already states: `missing` and `corrupt` send a person to two different places. Anything
 * else — a dropped connection, a response that did not match the contract — is not a claim about
 * the content at all and falls through to the sentence that names no cause.
 */
function evidenceContentCause(error: unknown): 'missing' | 'corrupt' | null {
  if (!(error instanceof RuntimeApiError)) return null;
  const data = error.apiError.code === 'workflow_rejected' ? error.apiError.data : null;
  return data !== null && data.reason === 'workflow_evidence_content_unavailable'
    ? data.cause
    : null;
}

function DownloadButton({
  byteSize,
  pending,
  onClick,
}: {
  readonly byteSize: number;
  readonly pending: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-evidence-download
      disabled={pending}
      onClick={onClick}
      className="rounded-md border border-line/35 bg-canvas/60 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:border-line/70 hover:text-fg disabled:opacity-60"
    >
      {inspectorCopy.evidenceDownload}
      <span className="ml-2 text-fg-subtle">{formatBytes(byteSize)}</span>
    </button>
  );
}

/**
 * Saving a file without navigating anywhere.
 *
 * A link to the runtime's `?download=true` route would be a navigation to a non-renderer origin,
 * and `isAllowedRendererNavigation` denies every one of those — the save would then depend on
 * Electron's download handling rather than on something this app controls. An object URL and a
 * programmatic click keep it in the web app on every host. The route variant stays for API
 * consumers.
 */
function useDownloadWhenReady({
  armed,
  blob,
  fileName,
  onDone,
}: {
  readonly armed: boolean;
  readonly blob: Blob | null;
  readonly fileName: string;
  readonly onDone: () => void;
}) {
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (!armed || blob === null) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noreferrer';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();

    /*
      Revoked a macrotask later, and the disarm goes with it.

      Not immediately: some engines have not started reading the blob when `click()` returns, and
      revoking under them cancels the save. And not with the disarm left outside, which is how this
      leaked — flipping `armed` from the effect body makes React re-run the deps and fire the
      cleanup *before* a zero-delay timeout does, so the `clearTimeout` cancelled the very revoke it
      was guarding. The URL then outlived every reference to it and pinned its blob for the life of
      the document.

      Both exits now revoke. `revokeObjectURL` on an already-revoked URL is a no-op, so the
      unmount path is safe to overlap with the timeout.
    */
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      done.current();
    }, 0);
    return () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    };
  }, [armed, blob, fileName]);
}

/** A name a person can find again: the record's key, plus whatever the media type suggests. */
function downloadFileName(record: WorkflowEvidenceDto): string {
  const path = record.content.sourcePath;
  if (path !== null) {
    const base = path.split('/').at(-1);
    if (base !== undefined && base.length > 0) return base;
  }
  return `${record.evidenceKey}${extensionFor(record.content.mediaType)}`;
}

function extensionFor(mediaType: string): string {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'application/json' || base.endsWith('+json')) return '.json';
  if (base === 'text/html') return '.html';
  if (base === 'text/markdown') return '.md';
  if (base === 'text/plain') return '.txt';
  if (base === 'image/svg+xml') return '.svg';
  if (base.startsWith('image/')) return `.${base.slice('image/'.length)}`;
  return '';
}

/**
 * A blob as text, decoding at most the preview cap unless the whole thing is asked for.
 *
 * `whole` exists for the render preview: a half-decoded document would be shown as a page rather
 * than read as text, and half a page is a picture of something that never existed.
 */
function useBlobText(blob: Blob | null, options: { readonly whole?: boolean } = {}): string | null {
  const whole = options.whole ?? false;
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (blob === null) {
      setText(null);
      return;
    }
    let live = true;
    setText(null);
    const slice = whole ? blob : blob.slice(0, previewCapBytes);
    void slice.text().then((value) => {
      if (live) setText(value);
    });
    return () => {
      live = false;
    };
  }, [blob, whole]);

  return text;
}

/** An object URL that lives exactly as long as the element showing it. */
function useObjectUrl(blob: Blob): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => {
      URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [blob]);

  return url;
}

function parseJson(text: string): { readonly value: unknown } | null {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}
