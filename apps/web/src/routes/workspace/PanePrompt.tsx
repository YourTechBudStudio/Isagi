import { Button, type ButtonVariant } from '../../components/Button.js';
import type { IconType } from '../../lib/icon.js';

export interface PanePromptAction {
  readonly label: string;
  readonly icon: IconType;
  readonly variant: Extract<ButtonVariant, 'secondary' | 'ghost'>;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** This action is the one running: it stays lit while the others recede. */
  readonly pending?: boolean;
}

/**
 * A pane body that asks the user how to recover: an icon, the text, an optional diagnostic line
 * (the code, then its detail), an optional inline error, then a centred row of actions ranked
 * `secondary` then `ghost`. With a `title`, the text is a title over a quieter body; without one,
 * the body alone takes the title's place.
 */
export function PanePrompt({
  icon: Icon,
  iconClassName,
  title = null,
  body,
  diagnostic = null,
  error = null,
  actions,
}: {
  readonly icon: IconType;
  readonly iconClassName: string;
  readonly title?: string | null;
  readonly body: string;
  readonly diagnostic?: { readonly code: string; readonly detail: string | null } | null;
  readonly error?: string | null;
  readonly actions: readonly PanePromptAction[];
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-5">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Icon size={18} aria-hidden className={iconClassName} />
        {title ? (
          <div className="space-y-1">
            <p className="font-mono text-[12px] text-fg-muted">{title}</p>
            <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">{body}</p>
          </div>
        ) : (
          <p className="font-mono text-[12px] text-fg-muted">{body}</p>
        )}
        {diagnostic ? (
          <p className="font-mono text-[10.5px] leading-relaxed text-fg-subtle">
            <span className="text-fg-muted">{diagnostic.code}</span>
            {diagnostic.detail ? ` · ${diagnostic.detail}` : null}
          </p>
        ) : null}
        {error ? (
          <p className="font-mono text-[10.5px] leading-relaxed text-error">{error}</p>
        ) : null}
        <div className="mt-0.5 flex flex-wrap items-center justify-center gap-2">
          {actions.map((action) => (
            <Button
              key={action.label}
              variant={action.variant}
              size="sm"
              icon={action.icon}
              disabled={action.disabled}
              aria-busy={action.pending || undefined}
              className={action.pending ? 'disabled:opacity-100!' : ''}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
