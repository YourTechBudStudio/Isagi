import type { IconType } from '../../lib/icon.js';

export function SurfaceFrameState({
  icon: Icon,
  title,
  body,
  tone = 'idle',
}: {
  readonly icon: IconType;
  readonly title: string;
  readonly body: string;
  readonly tone?: 'idle' | 'error';
}) {
  return (
    <div
      className={`grid h-full place-items-center rounded-md border bg-elevated/50 backdrop-blur-sm ${
        tone === 'error' ? 'border-error/30' : 'border-line/20'
      }`}
    >
      <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
        <Icon size={18} className={tone === 'error' ? 'text-error' : 'text-fg-subtle'} />
        <div>
          <p className="font-mono text-[12px] text-fg-muted">{title}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg-subtle">{body}</p>
        </div>
      </div>
    </div>
  );
}
