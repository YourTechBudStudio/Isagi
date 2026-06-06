export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export type ToastLifetime =
  | {
      readonly autoDismiss: true;
      readonly durationMs?: number | undefined;
    }
  | {
      readonly autoDismiss: false;
    };

export interface Toast {
  readonly id: string;
  readonly kind: ToastKind;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly lifetime: ToastLifetime;
}

export type ToastInput = Omit<Toast, 'id' | 'lifetime'> & {
  readonly id?: string | undefined;
  readonly lifetime?: ToastLifetime | undefined;
};
