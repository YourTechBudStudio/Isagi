import type { AgentHarness } from '@isagi/contracts';

import type { ApprovedHostEnvironment } from '../agent-sessions/harness/definition-types.js';

export type ExecutableProbeResult =
  | {
      readonly _tag: 'Available';
      readonly command: string;
      readonly version: string;
      readonly resolvedPath?: string | undefined;
    }
  | { readonly _tag: 'Missing'; readonly command: string }
  | {
      readonly _tag: 'Incompatible';
      readonly command: string;
      readonly version: string;
      readonly minimumVersion: string;
    }
  | {
      readonly _tag: 'ProbeFailed';
      readonly command: string;
      readonly reason:
        | 'timeout'
        | 'nonzero_exit'
        | 'malformed_output'
        | 'output_limit_exceeded'
        | 'spawn_failed';
      readonly diagnostic: string;
    };

export type HostEnvironmentResult =
  | { readonly _tag: 'Available'; readonly values: ApprovedHostEnvironment }
  | {
      readonly _tag: 'ProbeFailed';
      readonly values: ApprovedHostEnvironment;
      readonly diagnostic: string;
    };

export interface HostInventory {
  readonly environment: HostEnvironmentResult;
  readonly node: ExecutableProbeResult;
  readonly packageManagers: Readonly<{
    pnpm: ExecutableProbeResult;
    npm: ExecutableProbeResult;
    bun: ExecutableProbeResult;
  }>;
  readonly harnesses: Readonly<Record<AgentHarness, ExecutableProbeResult>>;
}

export type HostInventoryState =
  | { readonly _tag: 'Pending' }
  | {
      readonly _tag: 'Ready';
      readonly generation: number;
      readonly inventory: HostInventory;
      readonly refreshedAt: string;
    };

export type ExecutableAvailability = 'available' | 'missing' | 'incompatible' | 'probe_failed';

export function executableAvailability(result: ExecutableProbeResult): ExecutableAvailability {
  switch (result._tag) {
    case 'Available':
      return 'available';
    case 'Missing':
      return 'missing';
    case 'Incompatible':
      return 'incompatible';
    case 'ProbeFailed':
      return 'probe_failed';
  }
}
