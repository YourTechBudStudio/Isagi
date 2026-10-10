export { HostInventory, HostInventoryLive, type HostInventoryService } from './service.js';
export type {
  ExecutableProbeResult,
  HostEnvironmentResult,
  HostInventory as HostInventorySnapshot,
  HostInventoryState,
} from './types.js';
export {
  resolveUserShellEnvironment,
  UserShell,
  UserShellLive,
  type UserShellEnvironmentResult,
  type UserShellService,
} from '../../platform/process/user-shell.js';
