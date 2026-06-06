import type { ReactNode } from 'react';

import { ToastViewport } from './ToastViewport.js';

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToastViewport />
    </>
  );
}
