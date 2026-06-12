export const workbenchCopy = {
  emptyCommands: '// no commands yet',
  noCommandsRunning: '// no commands running',
  openCommandLogsTitle: (label: string) => `Open ${label} logs`,
  commandAuthoringTitle: 'Command authoring lands in the command-runner slice',
  mockLog: {
    stopped: 'mock: stopped command',
    started: 'mock: started command',
  },
} as const;
