export function didPendingActionSettleSuccessfully({
  previouslyPending,
  pending,
  error,
}: {
  readonly previouslyPending: boolean;
  readonly pending: boolean;
  readonly error: string | null;
}) {
  return previouslyPending && !pending && error === null;
}
