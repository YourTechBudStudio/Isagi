/**
 * The editor's one waiting treatment. Work of unknown length breathes; it never
 * spins and never claims progress it cannot measure. Reduced motion holds it
 * still, which reads as calm rather than as stalled because the sentence itself
 * says what is happening.
 */
export function EditorWait({ text }: { readonly text: string }) {
  return (
    <p className="animate-breathe font-mono text-[12px] text-fg-muted motion-reduce:animate-none">
      {text}
    </p>
  );
}
