/**
 * The inspector's sentence-level prose.
 *
 * Kept together and out of JSX so the wording is reviewable in one place, and so the honesty rules
 * this surface exists to hold are readable as sentences rather than inferred from markup: what a
 * value Isagi cannot read actually means, what a step never produced means, and what the inspector
 * genuinely does not know.
 *
 * Lives beside the components rather than in `src/copy/` because every string here is inspector
 * chrome — column headings, field values and empty states for one surface — while `copy/workflows.ts`
 * holds the prose the bar and the inspector share.
 */
export const inspectorCopy = {
  title: 'Inspect workflow',
  inspectLabel: 'Inspect',
  closeLabel: 'Close inspector',
  declaredTab: 'Declared',
  traceTab: 'Trace',
  evidenceTab: 'Evidence',
  declaredHint: 'The graph this run is pinned to, and where it is now.',
  traceHint: 'Every execution, in the order it ran.',
  evidenceHint: 'What the workflow chose to keep, and where each piece came from.',

  // Columns
  columnDeclared: 'Declared',
  columnRecorded: 'Recorded',
  columnOperations: 'Operations',
  columnWait: 'Wait',
  columnEvidence: 'Evidence',
  columnData: 'Data',

  // Declared column
  parametersRole: 'built by a mapping callback',
  outputMappingRole: 'applied by an output mapping callback',
  absentFromCurrentPin:
    'This node is not in the definition the run is pinned to now. What it recorded is still here.',
  notVisited: 'not visited',
  // A checkpoint node's one line, from its visits' status and nothing else.
  checkpointKind: 'checkpoint',
  checkpointCapturing: 'capturing…',
  checkpointFailed: 'capture failed',
  checkpointCaptured: 'captured',
  checkpointCaptures: (count: number) => `${count} captures`,
  checkpointNothingSaved: 'nothing saved',
  notAttempted: 'not attempted',

  // Recorded column
  noAttemptYet: 'dispatched, no attempt yet',
  stillOpen: 'still open',
  endUnknown: "unknown — the attempt's owner was interrupted",
  durationUnknown: 'unknown',
  soFar: 'so far',
  routingThrew: 'threw',
  routingUndecided: 'not decided',
  outputNotProduced: 'not produced',
  labelCaptureFailed: (diagnostic: string) => `capture failed · ${diagnostic} · the step still ran`,
  reusedProducerOutput: (pin: string | null) =>
    pin === null
      ? 'reduction replayed from the saved result'
      : `reduction replayed from the result produced under ${pin.slice(0, 7)}`,

  // Operations column
  edgesCannotCall: 'Routing code cannot call capabilities.',
  outcomesCannotCall: 'Outcomes cannot call capabilities.',
  subgraphNoDirectOperations: 'A subgraph makes no calls of its own. Its children do.',
  // Not "nothing happened inside": the frame does not exist yet, which is a different fact.
  subgraphNotEntered: 'This subgraph has not opened its graph yet.',
  childExecutions: 'Executions inside this subgraph',
  frameSegmentNoOperations: 'Graph setup and result code cannot call capabilities.',
  notVisitedNoOperations: 'Nothing has run here yet.',
  noOperations: 'No capability calls recorded.',
  operationsLoading: 'Reading this step’s operations…',
  operationsFailed: "Isagi couldn't read this step's operations.",
  operationsRetry: 'Try again',
  operationsPartial: 'Some of this step’s operations have not been read yet.',
  waitOpen: 'waiting on you',
  answerInTheBar: 'the workflow bar',
  nestedOperations: (operations: number, executions: number) =>
    `${operations} inside, across ${executions} execution${executions === 1 ? '' : 's'}`,

  // Data column
  dataEmpty: 'Nothing recorded for this step.',
  payloadAbsent: 'This step never produced this value.',
  payloadLoad: 'Show value',
  payloadLoading: 'Reading…',
  payloadUnavailableHeading: "Recorded, but Isagi can't read it back.",
  payloadUnavailableBody: (ref: string, cause: string) =>
    `The step produced this value and the run kept a reference to it (${ref}), but the payload store reports it ${cause}. Nothing else about this step is affected.`,
  payloadUnavailableFallback: (ref: string) =>
    `The step produced this value and the run kept a reference to it (${ref}), but it could not be read back. Nothing else about this step is affected.`,

  // Evidence column, and the Evidence tab's list
  //
  // Two spellings of one sentence, deliberately. The column's is a standalone line in an empty
  // column and is punctuated as one; the tree's sits under a group heading that already names the
  // visit, so it reads as a continuation of it rather than as its own statement.
  evidenceColumnSubtitle: 'this visit and below',
  evidenceColumnEmpty: 'Nothing captured here yet.',
  // Not "nothing captured here": the selection is a declared node nobody has visited, or a frame's
  // own setup or result code. Neither is a visit, and only a visit captures anything — so saying
  // the column is empty would answer a question this selection does not ask.
  evidenceColumnNoVisit: 'Evidence belongs to a node visit. This selection is not one.',
  evidenceGroupEmpty: 'nothing captured here yet',
  evidenceOpenAll: 'Open all of them in the Evidence tab.',
  evidenceRunEmpty: 'This run has not captured anything yet.',
  evidenceVisitEmpty: 'This visit has not captured anything yet.',
  evidenceFilteredEmpty: 'Nothing here matches those filters.',
  evidenceScopeRun: 'run',
  evidenceScopeVisit: 'visit',
  evidenceSubtree: 'and below',
  evidenceAllRoles: 'all roles',
  evidenceListLoading: 'Reading what this run captured\u2026',
  evidenceListFailed: "Isagi couldn't read what this run captured.",
  evidenceListRetry: 'Try again',
  evidenceRunCount: (count: number) =>
    `${count} captured \u00b7 in capture order, grouped by where it ran`,
  evidenceVisitCount: (count: number) => `${count} captured in this visit and below`,
  evidenceInside: (count: number) => `${count} inside`,
  evidenceNoLabels: 'none',

  // Evidence detail
  evidenceDownload: 'Download',
  evidenceCapturedAt: (at: string, pin: string) => `captured ${at} \u00b7 under ${pin}`,
  evidenceSourceNone: 'none',
  evidenceSourceNoneNote: 'the author gave no source; nothing is inferred',
  evidenceSourceInferred: 'inferred, latest operation',
  evidenceSourceUnresolvedOperation: 'unresolved \u00b7 no operation in this run matched the turn',
  // A file capture is bytes as they were at one instant, not a live window onto the path. Saying so
  // beside the path is what stops the path reading as somewhere to look for the current contents.
  evidenceFromPath: (at: string) => `bytes as they were at ${at}`,

  // Evidence content
  evidenceContentHeading: 'Content',
  evidenceContentLoading: 'Reading\u2026',
  evidenceContentLoad: 'Show content',
  evidenceHtmlSource: 'Source',
  evidenceHtmlRender: 'Render preview',
  evidenceHtmlSourceHint: 'Source is the default. Rendering is opt-in.',
  evidenceHtmlRenderHint:
    'Rendered in isolation: no scripts run, and nothing it links to will load.',
  evidenceTruncated: 'Preview stops at 256 KB. Download for the whole thing.',
  evidenceDownloadOnly: (mediaType: string) => `Isagi doesn't preview ${mediaType}. Download.`,
  evidenceUnavailableHeading: "Captured, but Isagi can't read it back.",
  evidenceUnavailableBody: (ref: string, cause: string) =>
    `The workflow saved this and the run kept a reference to it (${ref}), but the content store reports it ${cause}. The record above is still true; only the bytes are gone.`,
  evidenceUnavailableFallback: (ref: string) =>
    `The workflow saved this and the run kept a reference to it (${ref}), but it could not be read back. The record above is still true; only the bytes are gone.`,

  // Provenance
  //
  // Every unknown is a sentence about *why* it is unknown wherever the runtime knows why. A blank
  // cell would read as a value nobody bothered to show; these say which of several different things
  // actually happened.
  provenanceLabel: 'provenance',
  provenanceOnDemand: 'provenance, read on demand',
  provenanceLoading: 'Reading provenance\u2026',
  provenanceFailed: "Isagi couldn't read this operation.",
  provenanceUnknown: 'unknown',
  provenanceModelInherited: 'unknown \u00b7 inherited from the session',
  provenanceSessionUncorrelated: 'not correlated',
  provenanceTranscriptNotChecked: 'not checked',
  provenanceTranscriptNoLocator: 'no locator',
  provenanceTranscriptAvailable: 'available',
  provenanceTranscriptUnavailable: 'unavailable',
  // No total is computed. The provider reports uncached input, cache reads and cache writes
  // separately, and any single "input" figure would be one this run never reported.
  provenanceUsageNone: 'unknown',
  provenanceRuntime: (runtimeId: string, incarnationId: string) =>
    `${runtimeId} \u00b7 incarnation ${incarnationId}`,

  // Canvas
  catchingUp: 'Catching up with this run’s current definition…',
  layoutFailed: "Isagi couldn't lay this graph out.",
  layoutStale: "Isagi couldn't redraw this graph, so it still shows the previous shape.",
  layoutFirst: 'Laying out the graph…',
  structureFailed: "Isagi couldn't read this workflow's structure.",
  structureRetry: 'Try again',
  graphEmpty: 'This definition declares no nodes.',
  subgraphUnresolved: (graphKey: string) =>
    `${graphKey} is not in this definition, so its contents cannot be drawn.`,
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fit: 'Fit',
  focusLive: 'Go to the live step',
  expand: 'Expand',
  collapse: 'Collapse',

  // Trace
  traceEmpty: 'Nothing has run yet.',
  traceLegendRun: 'callback',
  traceLegendWait: 'wait',
  traceLegendSubgraph: 'subgraph',
  tracePaused: 'paused',
  traceNow: 'now',
  traceEnded: 'ended',

  // Header
  runFacts: 'Run facts',
  // Who decided where this run works. Shown only when somebody did decide: a run that went where it
  // was launched from says nothing, because there is nothing there a person did not already know.
  placementBySelector: 'chosen by workflow',
  placementByOverride: 'placed by caller',
  dockResize: 'Resize details',
  dockResizeHint: 'Up and down arrows resize the details panel.',
} as const;
