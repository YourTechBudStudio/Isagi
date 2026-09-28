/**
 * The inspector's sentence-level prose.
 *
 * Kept together and out of JSX so the wording is reviewable in one place, and so the honesty rules
 * this surface holds are readable as sentences: what Isagi cannot read, what a step never produced,
 * and what has simply not happened yet.
 *
 * Lives beside the components rather than in `src/copy/` because every string here is inspector
 * chrome, while `copy/workflows.ts` holds the prose the bar and the inspector share.
 */
export const inspectorCopy = {
  title: 'Inspect workflow',
  inspectLabel: 'Inspect',
  closeLabel: 'Close inspector',
  declaredTab: 'Declared',
  traceTab: 'Trace',
  declaredHint: 'The graph this run is on now, and where it is.',
  traceHint: 'Every execution, in the order it ran.',

  // Columns
  columnDeclared: 'Declared',
  columnRecorded: 'Recorded',
  columnOperations: 'Operations',
  columnWait: 'Wait',
  columnData: 'Data',
  dockEmpty: 'Select a node or a row to see what it recorded.',

  // Declared column
  absentFromCurrentBuild:
    "This node isn't in the build the run is on now. What it recorded is still here.",
  notVisited: 'not visited',
  // A checkpoint node's one line, from its executions and nothing else.
  checkpointKind: 'checkpoint',
  checkpointCapturing: 'capturing…',
  checkpointFailed: 'capture failed',
  checkpointCaptured: 'captured',
  checkpointCaptures: (count: number) => `${count} captures`,
  checkpointNothingSaved: 'nothing saved',

  // Recorded column
  stillOpen: 'still open',
  soFar: 'so far',
  outputNotProduced: 'not produced',
  olderBuild: (hash: string) => `${hash} · an earlier build`,
  waitOnYou: 'waiting on you',
  waitOpen: 'waiting',
  waitDelivered: 'answered',
  answerInTheBar: 'the workflow bar',
  detailLoading: 'Reading this step…',
  detailFailed: "Isagi couldn't read this step.",

  // Operations column
  edgesCannotCall: 'Routing code has no side effects.',
  outcomesCannotCall: 'Outcomes have no side effects.',
  subgraphNoDirectOperations: 'A subgraph does nothing itself. Its children do.',
  // Not "nothing happened inside": the child graph has not been entered yet.
  subgraphNotEntered: "This subgraph hasn't entered its graph yet.",
  invocationNoOperations: 'A graph does nothing itself. Its steps do.',
  checkpointNoOperations: 'A checkpoint copies files. It has no other side effects.',
  childExecutions: 'Executions inside this graph',
  notVisitedNoOperations: 'Nothing has run here yet.',
  noOperations: 'No side effects recorded.',
  noOperationsShort: 'no side effects',
  operationsLoading: 'Reading this step’s operations…',
  operationsFailed: "Isagi couldn't read this step's operations.",
  operationsRetry: 'Try again',
  operationRecorded: 'recorded',
  operationPrompt: 'prompt',
  operationReply: 'reply',
  operationOutput: 'output',
  replyPending: 'Not back yet.',
  // The runtime records a reply when the agent's turn ends; if it could not read it, it says so in
  // the run's log rather than inventing one.
  replyNotRecorded: 'No reply recorded. The log says why, if Isagi knew.',
  outputNotRecorded: 'No output recorded.',
  // No total is computed. The provider reports uncached input, cache reads and cache writes
  // separately, and any single "input" figure would be one this run never reported.
  usageUnknown: 'unknown',

  // Data column
  dataEmpty: 'Nothing recorded for this step.',

  // Checkpoint column
  columnCheckpoint: 'Checkpoint',
  checkpointCounts: (scopes: number, files: number) =>
    `${plural(scopes, 'scope')} · ${plural(files, 'file')}`,
  checkpointCapturingNote: 'Capturing. Nothing is saved until it finishes.',
  checkpointNothingSavedNote: 'Nothing was saved. No checkpoint exists for this step.',
  checkpointDetailFailed: "Isagi couldn't read this checkpoint.",

  // Checkpoint files, in the dock's `files` tab and the Checkpoints tab
  checkpointFilesTab: 'files',
  checkpointFilesLoading: 'Reading this checkpoint’s files…',
  checkpointFilesFailed: "Isagi couldn't read this checkpoint's files.",
  checkpointFilesRetry: 'Try again',
  checkpointFilesEmpty: 'This checkpoint saved no files.',
  checkpointFilesHeading: (counts: string, commit: string) => `${counts} · on ${commit}`,
  checkpointDirFiles: (count: number) => plural(count, 'file'),
  checkpointScopeEmpty: 'empty',
  checkpointMissingTag: 'missing',
  checkpointMissingNote:
    "This path didn't exist when the checkpoint was taken. An export makes sure it doesn't exist.",
  checkpointSelectHint: 'Pick a file to see what was saved.',
  checkpointExecutable: 'executable',
  checkpointNotExecutable: 'not executable',
  checkpointDownloadOnly: 'No preview for this type. Download it and open it yourself.',
  checkpointUnavailableHeading: "Saved, but Isagi can't read it back.",
  checkpointUnavailableBody: (path: string) =>
    `The checkpoint saved ${path}, but the content store can't serve its bytes. The record above is still true; only the bytes are gone.`,

  // File content
  contentLoad: 'Show content',
  contentLoading: 'Reading…',
  contentDownload: 'Download',
  contentTruncated: 'Preview stops at 256 KB. Download for the whole thing.',
  // A read that failed for a reason the runtime did not name. That is not evidence the bytes are
  // gone, so it must not say they are.
  contentReadFailed:
    "Isagi couldn't read these bytes just now. That says nothing about whether they're still saved.",
  contentReadRetry: 'Try again',
  htmlSource: 'Source',
  htmlRender: 'Render preview',
  htmlSourceHint: 'Source is the default. Rendering is opt-in.',
  htmlRenderHint: 'Rendered in isolation: no scripts run, and nothing it links to will load.',

  // Checkpoints tab
  checkpointsTab: 'Checkpoints',
  checkpointsHint: 'What an export of each checkpoint would contain.',
  checkpointsLoading: 'Reading this run’s checkpoints…',
  checkpointsFailed: "Isagi couldn't read this run's checkpoints.",
  checkpointsRetry: 'Try again',
  checkpointsEmpty: "This run hasn't saved a checkpoint yet.",
  checkpointVisits: (count: number) => plural(count, 'capture'),
  checkpointCopy: 'Copy',
  checkpointCopied: 'Copied',

  // Reading the run
  readingRun: 'Reading this run…',
  runReadFailed: "Isagi couldn't read this run, so there's nothing to show yet.",
  runRefreshFailed: "Isagi couldn't refresh this run, so what's shown here may be out of date.",
  eventsReadFailed:
    "Isagi couldn't read this run's event log, so pauses, reloads, wait times and environment steps are missing here.",
  readRetry: 'Try again',

  // Canvas
  readingStructure: 'Reading this build’s graph…',
  layoutFailed: "Isagi couldn't lay this graph out.",
  layoutStale: "Isagi couldn't redraw this graph, so it still shows the previous shape.",
  layoutFirst: 'Laying out the graph…',
  structureFailed: "Isagi couldn't read this workflow's structure.",
  structureRetry: 'Try again',
  graphEmpty: 'This build declares no nodes.',
  subgraphUnresolved: (graphKey: string) =>
    `${graphKey} isn't in this build, so its contents can't be drawn.`,
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit',
  focusLive: 'Go to the live step',
  expand: 'Expand',
  collapse: 'Collapse',

  // Trace
  traceEmpty: 'Nothing has run yet.',
  traceLegendRun: 'run',
  traceLegendWait: 'wait',
  traceLegendSubgraph: 'subgraph',
  traceNow: 'now',
  traceEnded: 'ended',
  traceReloadLabel: 'reload',
  traceRunEvents: 'run',
  traceRunEventsLabel: 'Run and environment events',
  traceReloaded: (to: string | null) =>
    to === null ? 'Reloaded the latest build' : `Reloaded the latest build (${to.slice(0, 14)})`,
  retryOf: (executionId: number) => `retry of ${executionId}`,
  routedTo: (destination: string) => `routed to ${destination}`,

  // Header
  // Who decided where this run works. Shown only when somebody did decide: a run that went where it
  // was launched from says nothing, because there is nothing there a person did not already know.
  placementBySelector: 'chosen by workflow',
  placementByOverride: 'placed by caller',
  dockResize: 'Resize details',
} as const;

function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}
