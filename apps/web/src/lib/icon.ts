import type { ComponentType } from 'react';

/** Shape of a Lucide icon component, shared across action surfaces. */
export type IconType = ComponentType<{ size?: number; className?: string }>;
