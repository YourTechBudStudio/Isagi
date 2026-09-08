/**
 * Whether a filesystem error is the operating system refusing access.
 *
 * Shared because two independent surfaces must agree on it: project path
 * validation turns it into the `permission_denied` rejection reason, and
 * reconciliation turns it into the `missingReason` the user reads on the
 * missing-project canvas. If the two drifted, the same unreadable folder would
 * be described differently depending on which one looked at it.
 *
 * Deliberately narrow — `EACCES` and `EPERM` only. It is not the seed of a
 * filesystem service or a general errno taxonomy.
 */
export function isPermissionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { readonly code?: unknown }).code === 'EACCES' ||
      (error as { readonly code?: unknown }).code === 'EPERM')
  );
}
