export const HOST_RUNTIME_STATUS_PROTOCOL_VERSION = 1 as const;

/**
 * Why the desktop's managed runtime failed. The desktop only ever runs the runtime it launched itself, on the
 * machine the window is on; a remote runtime is used through a browser.
 */
export type HostRuntimeFailureReason =
  | 'launch_configuration_invalid'
  | 'stage_invalid'
  | 'spawn_failed'
  | 'readiness_malformed'
  | 'readiness_timeout'
  | 'exited_before_ready'
  | 'health_check_failed'
  | 'process_error'
  | 'exited_after_ready';

export interface HostRuntimeDiagnostic {
  readonly message?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
}

/** The managed runtime's lifecycle, as the desktop main process tracks it to decide what its window shows. */
export type HostRuntimeStatusSnapshot =
  | {
      readonly protocolVersion: typeof HOST_RUNTIME_STATUS_PROTOCOL_VERSION;
      readonly revision: number;
      readonly state: 'connecting';
    }
  | {
      readonly protocolVersion: typeof HOST_RUNTIME_STATUS_PROTOCOL_VERSION;
      readonly revision: number;
      readonly state: 'ready';
    }
  | {
      readonly protocolVersion: typeof HOST_RUNTIME_STATUS_PROTOCOL_VERSION;
      readonly revision: number;
      readonly state: 'failed';
      readonly reason: HostRuntimeFailureReason;
      readonly diagnostic?: HostRuntimeDiagnostic;
    };
