import { useEffect, useMemo, useRef, useState } from 'react';

import type { WorkflowCheckpointFileDto } from '@isagi/contracts';
import { RuntimeApiError } from '@isagi/runtime-client';

import { useWorkflowCheckpointFileContent } from '../../../lib/workspace/workflow/queries.js';
import {
  baseName,
  imageMediaTypeForPath,
  presentationForPath,
  previewCapBytes,
  type CheckpointPresentation,
} from './checkpoint-view.js';
import { inspectorCopy } from './copy.js';
import { formatBytes } from './format.js';
import { JsonTree, TextValue } from './WorkflowPayloadValue.js';

/**
 * A saved checkpoint file's bytes, and the different things "you cannot see them" can mean.
 *
 * The rule that matters most here: **"Isagi cannot read this" and "this was never saved" must never
 * collapse into each other.** A file listed in a checkpoint was saved, so the record's own metadata
 * stays standing beside whatever this viewer says about the bytes.
 *
 * What is fetched, and when, is deliberate. A preview at or under the cap loads on selection; a
 * larger one waits for a click. Arrow-keying down a tree must not pull a megabyte per row. The route
 * serves whole files and has no ranges, so the 256 KB cap bounds what is *rendered*, never what is
 * transferred.
 *
 * The route always answers `application/octet-stream`, so the presentation comes from the path.
 * HTML is shown as source, and rendered only on request inside a sandboxed frame; SVG is shown
 * through `<img>`, where its scripts never run.
 */

interface ContentSubject {
  readonly checkpointId: number;
  readonly path: string;
  readonly presentation: CheckpointPresentation;
  readonly byteSize: number;
  readonly fileName: string;
  /** Given to image bytes whose response did not say what they are. */
  readonly imageType: string | null;
  readonly imageAlt: string;
  readonly imageCaption: string;
}

/** One saved checkpoint file's bytes, for the dock's `files` tab and the Checkpoints tab. */
export function WorkflowCheckpointFileContent({
  checkpointId,
  file,
  compact = false,
}: {
  readonly checkpointId: number;
  readonly file: WorkflowCheckpointFileDto;
  readonly compact?: boolean;
}) {
  const name = baseName(file.path);
  return (
    <ContentViewer
      key={`${checkpointId}/${file.path}`}
      compact={compact}
      subject={{
        checkpointId,
        path: file.path,
        presentation: presentationForPath(file.path),
        byteSize: file.sizeBytes,
        fileName: name,
        imageType: imageMediaTypeForPath(file.path),
        imageAlt: name,
        imageCaption: `${name} · ${formatBytes(file.sizeBytes)}`,
      }}
    />
  );
}

/**
 * Keyed by its caller on the file, because a new file is a new question: the previous file's
 * "shown" state must not carry over and auto-fetch something the person never asked for.
 */
function ContentViewer({
  subject,
  compact,
}: {
  readonly subject: ContentSubject;
  readonly compact: boolean;
}) {
  const previewable = subject.presentation !== 'download';
  const withinCap = subject.byteSize <= previewCapBytes;
  const [requested, setRequested] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [htmlMode, setHtmlMode] = useState<'source' | 'render'>('source');

  const wanted = downloading || requested || (previewable && withinCap);
  const query = useWorkflowCheckpointFileContent(subject.checkpointId, subject.path, {
    enabled: wanted,
  });
  const blob = query.data ?? null;

  useDownloadWhenReady({
    armed: downloading,
    blob,
    fileName: subject.fileName,
    onDone: () => setDownloading(false),
  });

  const download = (
    <DownloadButton
      byteSize={subject.byteSize}
      pending={downloading && blob === null && query.error === null}
      onClick={() => setDownloading(true)}
    />
  );

  if (query.error !== null) {
    return isContentUnavailable(query.error) ? (
      <UnreadableContent subject={subject} />
    ) : (
      <FailedRead onRetry={() => void query.refetch()} />
    );
  }

  if (!previewable) {
    return (
      <p className="flex flex-wrap items-center gap-2 py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.checkpointDownloadOnly}
        {download}
      </p>
    );
  }

  if (!wanted) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-1.5">
        <button
          type="button"
          data-content-load
          onClick={() => setRequested(true)}
          className="rounded-md border border-line/35 bg-canvas/60 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:border-line/70 hover:text-fg"
        >
          {inspectorCopy.contentLoad}
          <span className="ml-2 text-fg-subtle">{formatBytes(subject.byteSize)}</span>
        </button>
        {download}
      </div>
    );
  }

  if (blob === null) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.contentLoading}
      </p>
    );
  }

  return (
    <div>
      <ContentBody
        presentation={subject.presentation}
        blob={blob}
        subject={subject}
        compact={compact}
        htmlMode={htmlMode}
        onHtmlMode={setHtmlMode}
      />
      <div className="mt-2">{download}</div>
    </div>
  );
}

function ContentBody({
  presentation,
  blob,
  subject,
  compact,
  htmlMode,
  onHtmlMode,
}: {
  readonly presentation: Exclude<CheckpointPresentation, 'download'>;
  readonly blob: Blob;
  readonly subject: ContentSubject;
  readonly compact: boolean;
  readonly htmlMode: 'source' | 'render';
  readonly onHtmlMode: (mode: 'source' | 'render') => void;
}) {
  if (presentation === 'image') return <ContentImage blob={blob} subject={subject} />;
  if (presentation === 'html') {
    return <ContentHtml blob={blob} compact={compact} mode={htmlMode} onMode={onHtmlMode} />;
  }
  return <ContentTextual blob={blob} json={presentation === 'json'} />;
}

/**
 * Text and JSON, capped at 256 KB of *bytes*.
 *
 * The cap is applied to the slice that is decoded, not to the decoded string, so a pathological
 * multi-byte document cannot slip past it. JSON over the cap falls back to the text view: a
 * truncated document does not parse, and a tree built from half a file would be a lie about its
 * shape. The same fallback covers bytes that claim `application/json` and are not.
 */
function ContentTextual({ blob, json }: { readonly blob: Blob; readonly json: boolean }) {
  const truncated = blob.size > previewCapBytes;
  const text = useBlobText(blob);

  if (text === null) {
    return (
      <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
        {inspectorCopy.contentLoading}
      </p>
    );
  }

  const parsed = json && !truncated ? parseJson(text) : null;
  return (
    <>
      {parsed === null ? <TextValue text={text} /> : <JsonTree value={parsed.value} depth={0} />}
      {truncated && (
        <p className="mt-2 font-mono text-[11px] text-amber">{inspectorCopy.contentTruncated}</p>
      )}
    </>
  );
}

function ContentImage({
  blob,
  subject,
}: {
  readonly blob: Blob;
  readonly subject: ContentSubject;
}) {
  // Octet-stream bytes are re-typed from the path: an `<img>` sniffs raster formats on its own but
  // renders an SVG only when told that is what it is.
  const typed = useMemo(
    () =>
      subject.imageType === null || blob.type === subject.imageType
        ? blob
        : new Blob([blob], { type: subject.imageType }),
    [blob, subject.imageType],
  );
  const url = useObjectUrl(typed);
  if (url === null) return null;
  return (
    <figure className="m-0">
      <span className="inline-block rounded-lg border border-line/30 bg-scrim/40 p-1.5">
        <img src={url} alt={subject.imageAlt} className="block max-w-full rounded" />
      </span>
      <figcaption className="mt-1.5 font-mono text-[11px] text-fg-subtle">
        {subject.imageCaption}
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
 * Source is the default because a saved page is a file the run produced, and rendering it is a
 * second, opt-in question.
 */
function ContentHtml({
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
              {value === 'source' ? inspectorCopy.htmlSource : inspectorCopy.htmlRender}
            </button>
          ))}
        </div>
        <span className="font-mono text-[11px] text-fg-subtle">
          {mode === 'source' ? inspectorCopy.htmlSourceHint : inspectorCopy.htmlRenderHint}
        </span>
      </div>
      {mode === 'source' ? (
        source === null ? (
          <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
            {inspectorCopy.contentLoading}
          </p>
        ) : (
          <>
            <TextValue text={source} />
            {truncated && (
              <p className="mt-2 font-mono text-[11px] text-amber">
                {inspectorCopy.contentTruncated}
              </p>
            )}
          </>
        )
      ) : full === null ? (
        <p className="py-1.5 font-mono text-[11.5px] text-fg-subtle">
          {inspectorCopy.contentLoading}
        </p>
      ) : (
        <iframe
          title={inspectorCopy.htmlRender}
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
 * Bytes the checkpoint lists and the content store cannot serve.
 *
 * Only ever rendered beside the file's own fields, never in place of them. A checkpoint that saved
 * is a durable fact about the run; losing its bytes degrades what can be read back and changes
 * nothing about what happened.
 */
function UnreadableContent({ subject }: { readonly subject: ContentSubject }) {
  return (
    <div
      data-content-unavailable
      className="max-w-xl rounded-lg border border-dashed border-error/45 bg-error/5 px-3 py-2.5"
    >
      <p className="text-[13px] text-fg">{inspectorCopy.checkpointUnavailableHeading}</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
        {inspectorCopy.checkpointUnavailableBody(subject.path)}
      </p>
    </div>
  );
}

/**
 * A read that failed without the runtime naming a cause: a dropped connection, a response that did
 * not match the contract. That says nothing about the saved bytes, so it says so and offers the
 * read again, while the record's metadata stays where it is.
 */
function FailedRead({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div data-content-read-failed className="flex flex-wrap items-center gap-2 py-1.5">
      <p className="m-0 font-mono text-[11.5px] text-amber">{inspectorCopy.contentReadFailed}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md bg-white/6 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:bg-white/10"
      >
        {inspectorCopy.contentReadRetry}
      </button>
    </div>
  );
}

/**
 * Whether the runtime said the saved bytes cannot be read. Anything else — a dropped connection, a
 * response that did not match the contract — is not a claim about the bytes, and is shown as a
 * failed read that can be retried.
 */
function isContentUnavailable(error: unknown): boolean {
  if (!(error instanceof RuntimeApiError)) return false;
  const data = error.apiError.code === 'workflow_rejected' ? error.apiError.data : null;
  return data !== null && data.reason === 'workflow_checkpoint_content_unavailable';
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
      data-content-download
      disabled={pending}
      onClick={onClick}
      className="rounded-md border border-line/35 bg-canvas/60 px-2.5 py-1 font-mono text-[11px] text-fg-muted transition duration-micro ease-expo hover:border-line/70 hover:text-fg disabled:opacity-60"
    >
      {inspectorCopy.contentDownload}
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
