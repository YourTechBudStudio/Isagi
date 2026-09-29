/**
 * The validation child. `cli.ts` runs this file with `process.execPath` from an empty temporary
 * directory that holds only a copy of the workflow bundle:
 *
 *   node validate-artifact.js <isolated artifact> <result file> <worktree path>
 *
 * It imports the bundle, reads its declared structure, calls `command()` with a minimal origin, and
 * checks the manifest. It reports through the result file rather than stdout, so workflow code that
 * logs during import or `command()` cannot corrupt the report, and it always exits 0 once the
 * report is written. A crash, hang, or early exit is judged by the parent from the missing report.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  checkCommandManifest,
  describeWorkflowModule,
  type StructureDiagnostic,
  type WorkflowStructureDescriptor,
} from './structure.js';

export type ValidationReport =
  | { readonly ok: true; readonly descriptor: WorkflowStructureDescriptor }
  | {
      readonly ok: false;
      readonly error: string;
      readonly diagnostics?: readonly StructureDiagnostic[];
    };

function readArguments() {
  const [artifactPath, resultPath, worktreePath] = process.argv.slice(2);
  if (!artifactPath || !resultPath || !worktreePath) {
    throw new Error('Usage: validate-artifact.js <artifact> <result file> <worktree path>');
  }
  return { artifactPath, resultPath, worktreePath };
}

const { artifactPath, resultPath, worktreePath } = readArguments();

function finish(report: ValidationReport): never {
  writeFileSync(resultPath, JSON.stringify(report));
  process.exit(0);
}

/** The thrown value's stack when it has one, so the author sees where their code failed. */
function cause(error: unknown): string {
  const stack =
    typeof error === 'object' && error !== null && 'stack' in error ? error.stack : undefined;
  return String(stack || error);
}

let artifact: unknown;
try {
  artifact = await import(pathToFileURL(artifactPath).href);
} catch (error) {
  finish({
    ok: false,
    error: `Importing the bundle threw before any workflow definition could be read:\n${cause(error)}`,
  });
}

const result = describeWorkflowModule(artifact);
if (!result.ok) {
  finish({
    ok: false,
    error: 'The bundle does not declare a valid workflow structure.',
    diagnostics: result.diagnostics,
  });
}

// `describeWorkflowModule` succeeded, so the default export is a workflow with a command().
const workflow = (artifact as { readonly default: { command(origin: unknown): unknown } }).default;
let manifest: unknown;
try {
  manifest = await workflow.command({
    worktreeId: 0,
    worktreePath,
    surfaceId: null,
    paneId: null,
    agentSessionId: null,
  });
} catch (error) {
  finish({
    ok: false,
    error: `command() threw when called with a minimal origin. command() must succeed without optional surface, pane or agent-session context.\n${cause(error)}`,
  });
}

const problems = checkCommandManifest(manifest);
finish(
  problems.length > 0
    ? { ok: false, error: problems.join('\n') }
    : { ok: true, descriptor: result.descriptor },
);
