export const HOST_RUNTIME_STATUS_PROTOCOL_VERSION = 1 as const;

export type HostRuntimeOwnership = 'managed' | 'external';

export type HostRuntimeFailureReason =
  | 'launch_configuration_invalid'
  | 'stage_invalid'
  | 'spawn_failed'
  | 'readiness_malformed'
  | 'readiness_timeout'
  | 'exited_before_ready'
  | 'health_check_failed'
  | 'process_error'
  | 'exited_after_ready'
  | 'external_health_check_failed';

export interface HostRuntimeDiagnostic {
  readonly message?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
}

export type HostRuntimeStatusSnapshot =
  | {
      readonly protocolVersion: typeof HOST_RUNTIME_STATUS_PROTOCOL_VERSION;
      readonly revision: number;
      readonly ownership: HostRuntimeOwnership;
      readonly state: 'connecting';
    }
  | {
      readonly protocolVersion: typeof HOST_RUNTIME_STATUS_PROTOCOL_VERSION;
      readonly revision: number;
      readonly ownership: HostRuntimeOwnership;
      readonly state: 'ready';
    }
  | {
      readonly protocolVersion: typeof HOST_RUNTIME_STATUS_PROTOCOL_VERSION;
      readonly revision: number;
      readonly ownership: 'external';
      readonly state: 'unreachable';
      readonly reason: 'external_health_check_failed';
      readonly diagnostic?: HostRuntimeDiagnostic;
    }
  | {
      readonly protocolVersion: typeof HOST_RUNTIME_STATUS_PROTOCOL_VERSION;
      readonly revision: number;
      readonly ownership: 'managed';
      readonly state: 'failed';
      readonly reason: Exclude<HostRuntimeFailureReason, 'external_health_check_failed'>;
      readonly diagnostic?: HostRuntimeDiagnostic;
    };
