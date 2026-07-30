// User-facing prose for the desktop update surface: the rail footer's status
// line and the restart confirmation.
//
// This is working chrome and a consequential confirmation, so nothing here gets
// a joke, a mono whisper aside, or a marketing verb. The footer's own labels are
// lowercase mono tokens — they sit on the version line and read as machine
// status, not as sentences. The confirmation is the one place that speaks in
// full sentences, because it is asking the user to accept a consequence.
//
// The confirmation states what is true and no more: agents stop because Isagi
// has to close. It does not promise the work resumes, and it does not claim data
// is lost — neither is something this surface can honestly know.

export const updateCopy = {
  // Mono status tokens on the version line.
  status: {
    checking: 'checking…',
    upToDate: 'up to date',
    downloading: (percent: number) => `${percent}%`,
    installing: 'closing…',
    checkFailed: 'check failed',
    downloadFailed: 'download failed',
    manualRequired: 'update manually',
  },

  actions: {
    check: 'Check for updates',
    restart: 'Restart to update',
  },

  // Accessible descriptions. The visible tokens are terse by design, so the
  // assistive text carries the version and the consequence.
  described: {
    installed: (version: string) => `Isagi ${version} installed`,
    downloading: (version: string, percent: number) =>
      `Downloading Isagi ${version} — ${percent}% complete`,
    restart: (version: string) => `Restart to update to Isagi ${version}`,
    installing: (version: string) => `Closing Isagi to install ${version}`,
    checkFailed: "Couldn't check for updates. Try again.",
    downloadFailed: (version: string) => `Couldn't download Isagi ${version}. Try again.`,
    manualRequired: (version: string) =>
      `Isagi ${version} has to be installed manually on this build. Open the download page.`,
  },

  confirm: {
    workingTitle: (count: number) =>
      count === 1 ? '1 agent is working right now.' : `${count} agents are working right now.`,
    workingBody: (count: number, version: string) =>
      count === 1
        ? `Installing ${version} closes Isagi, and that agent stops where it is.`
        : `Installing ${version} closes Isagi, and those agents stop where they are.`,
    unknownTitle: "Isagi couldn't check what's running.",
    unknownBody: (version: string) =>
      `Installing ${version} closes Isagi. Anything still working stops where it is.`,
    cancel: 'Keep working',
    proceed: 'Restart anyway',
  },
} as const;
