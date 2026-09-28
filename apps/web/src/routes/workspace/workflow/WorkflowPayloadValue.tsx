import { useMemo, useState } from 'react';

/**
 * A recorded JSON value: what a node returned, what came back, where the edge went, the state after
 * a step, or an operation's request and result.
 *
 * Values travel whole with the execution, so this only renders. JSON `null`, an empty string,
 * `false` and `0` are each values the step produced, never "nothing"; a value the runtime has not
 * recorded yet is `undefined` and shown as a dash.
 */
export function WorkflowPayloadValue({ value }: { readonly value: unknown }) {
  return <PayloadBody value={value} />;
}

function PayloadBody({ value }: { readonly value: unknown }) {
  if (typeof value === 'string') return <TextValue text={value} />;
  return <JsonTree value={value} depth={0} />;
}

/**
 * Text with line numbers.
 *
 * Exported because checkpoint files and operation prompts render through it too, and a second
 * implementation of "text with line numbers" is exactly the drift the reuse lens exists to stop.
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
