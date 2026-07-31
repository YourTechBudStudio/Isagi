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
//
// A provider event can omit the version, so every sentence that names one has a
// versionless form. This is presentation hardening, not validation: the sentence
// simply stops claiming a fact it does not have, rather than printing a blank
// where the version should be.

/** An empty or whitespace-only version is a version we do not have. */
const named = (version: string) => version.trim().length > 0;
/** Reads naturally in both forms: "Installing 1.4.0 closes Isagi" / "Installing the update closes Isagi". */
const installTarget = (version: string) => (named(version) ? version : 'the update');

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
    // The remedy has not changed — only the last attempt at it. The token says
    // what happened rather than repeating the instruction, because a control
    // that still reads `update manually` after doing nothing is the failure.
    downloadPageFailed: "couldn't open",
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
      named(version)
        ? `Downloading Isagi ${version} — ${percent}% complete`
        : `Downloading the update — ${percent}% complete`,
    restart: (version: string) =>
      named(version) ? `Restart to update to Isagi ${version}` : 'Restart to update',
    installing: (version: string) =>
      named(version)
        ? `Closing Isagi to install ${version}`
        : 'Closing Isagi to install the update',
    checkFailed: "Couldn't check for updates. Try again.",
    downloadFailed: (version: string) =>
      named(version)
        ? `Couldn't download Isagi ${version}. Try again.`
        : "Couldn't download the update. Try again.",
    // No version, ever. This state is decided before any provider is contacted,
    // so there is no available version to name — the remedy is the whole point.
    manualRequired: 'This installation has to be updated manually. Open the download page.',
    // Names the browser, because that is the part that failed and the part the
    // user can do something about — the download page itself is fine.
    downloadPageFailed: "Couldn't open the download page in a browser. Try again.",
  },

  confirm: {
    workingTitle: (count: number) =>
      count === 1 ? '1 agent is working right now.' : `${count} agents are working right now.`,
    workingBody: (count: number, version: string) =>
      count === 1
        ? `Installing ${installTarget(version)} closes Isagi, and that agent stops where it is.`
        : `Installing ${installTarget(version)} closes Isagi, and those agents stop where they are.`,
    unknownTitle: "Isagi couldn't check what's running.",
    unknownBody: (version: string) =>
      `Installing ${installTarget(version)} closes Isagi. Anything still working stops where it is.`,
    cancel: 'Keep working',
    proceed: 'Restart anyway',
  },
} as const;
