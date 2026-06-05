import type { ButtonHTMLAttributes, ReactNode } from 'react';

import type { IconType } from '../lib/icon.js';
import { Kbd } from './Kbd.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'border border-blue/32 bg-blue/15 text-fg hover:bg-blue/22',
  secondary: 'border border-line/40 bg-transparent text-fg-muted hover:border-line/60 hover:text-fg',
  ghost: 'border border-transparent bg-transparent text-fg-subtle hover:bg-white/6 hover:text-fg',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'gap-2 px-3 py-2 text-[12.5px]',
  md: 'gap-2.5 px-4 py-2.5 text-[13px]',
};

/**
 * The one button. Variants carry the colour intent (primary accent, secondary
 * outline, ghost pill), sizes carry the density, and the optional `icon` /
 * `shortcut` slots keep add-actions and key hints consistent everywhere. The
 * shortcut floats right so a full-width button reads label-on-left, key-on-right.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  shortcut,
  fullWidth = false,
  children,
  className = '',
  ...props
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconType;
  shortcut?: ReactNode;
  fullWidth?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`items-center rounded-md font-medium transition duration-micro ease-expo disabled:cursor-not-allowed disabled:opacity-60 ${fullWidth ? 'flex w-full' : 'inline-flex'} ${SIZE[size]} ${VARIANT[variant]} ${className}`}
      {...props}
    >
      {Icon && <Icon size={size === 'sm' ? 14 : 15} className="shrink-0" />}
      <span className="truncate">{children}</span>
      {shortcut && <Kbd className="ml-auto">{shortcut}</Kbd>}
    </button>
  );
}
