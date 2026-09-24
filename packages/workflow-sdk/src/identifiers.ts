/**
 * Author-declared identifiers. They stay plain strings: an edge destination names either a node or
 * an outcome, and making them separate branded types would force authors to disambiguate something
 * the graph already resolves. Shape is enforced by structural validation, not by the type system.
 */
export type WorkflowNodeId = string;
export type WorkflowEdgeId = string;
export type WorkflowOutcomeId = string;
export type WorkflowGraphKey = string;

/** Every author-declared identifier must match this. Enforced by structural validation. */
export const workflowIdentifierPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
