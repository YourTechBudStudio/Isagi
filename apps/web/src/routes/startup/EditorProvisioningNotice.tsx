import type { EditorProvisioningState } from '@isagi/contracts';

import { Button } from '../../components/Button.js';
import { editorProvisioningCopy } from '../../copy/index.js';
import { BootBody, BootTitle } from './StartupSurfaces.js';

/**
 * A provisioning failure, unfolded on the boot surface.
 *
 * Only the failure gets this treatment. The transient states are a status line
 * under the track and nothing more: a download the user did not ask for and
 * cannot steer has no business explaining itself at length, and the track's own
 * motion already says it is alive.
 *
 * The diagnostic is framed as the runtime's words, not ours, and the retry
 * appears only where retrying could change the answer.
 */
export function EditorProvisioningNotice({
  state,
  retrying,
  onRetry,
}: {
  readonly state: Extract<EditorProvisioningState, { status: 'failed' }>;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  const retryable = editorProvisioningCopy.retryable[state.reason];

  return (
    <>
      <BootTitle>{editorProvisioningCopy.failure.title[state.reason]}</BootTitle>
      <BootBody>{editorProvisioningCopy.failure.body[state.reason]}</BootBody>
      <p
        data-slot="diagnostic-chip"
        className="mt-3.5 max-w-[72ch] overflow-x-auto rounded-sm border border-error/24 bg-error/8 px-3 py-2 text-left font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-error"
      >
        {state.reason}
        {state.diagnostic ? ` · ${state.diagnostic}` : null}
      </p>
      {retryable ? (
        <div className="mt-5 flex gap-2.5">
          <Button variant="primary" size="sm" disabled={retrying} onClick={onRetry}>
            {retrying ? editorProvisioningCopy.retrying : editorProvisioningCopy.retry}
          </Button>
        </div>
      ) : null}
    </>
  );
}
