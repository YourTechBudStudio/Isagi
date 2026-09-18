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
  declaredHint: 'The graph this run is pinned to, and where it is now.',
  traceHint: 'Every execution, in the order it ran.',

  // Columns
  columnDeclared: 'Declared',
  columnRecorded: 'Recorded',
  columnOperations: 'Operations',
  columnWait: 'Wait',
  columnData: 'Data',

  // Declared column
  parametersRole: 'built by a mapping callback',
  outputMappingRole: 'applied by an output mapping callback',
  absentFromCurrentPin:
    'This node is not in the definition the run is pinned to now. What it recorded is still here.',
  notVisited: 'not visited',
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
