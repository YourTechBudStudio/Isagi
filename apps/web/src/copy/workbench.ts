export const workbenchCopy = {
  emptyCommands: '// no commands yet',
  noCommandsRunning: '// no commands running',
  commandsLoading: '// loading commands',
  commandsConfigError: 'commands config error',
  commandsUnavailable: 'commands unavailable',
  openCommandLogsTitle: (label: string) => `Open ${label} logs`,
  commandAuthoringTitle: 'Add commands in .isagi/config.yaml',
  commandExecutionUnavailableTitle: 'Command execution lands in the next phase',
  commandIdleDetail: 'This command has not run yet.',
  commandEmptyLog: '[isagi] No output recorded for this run.',
  commandConfigDiagnosticTitle: 'Command config needs a look.',
  commandConfigDiagnosticBody:
    'Fix .isagi/config.yaml in this worktree, then refresh the command drawer.',
  commandReadFailedTitle: 'Commands are unavailable.',
  refreshCommands: 'Refresh',
} as const;
