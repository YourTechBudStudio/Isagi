#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hashArtifact,
  hashWorkflowInputs,
  isWorkflowSourcePath,
  serializeWorkflowBuildManifest,
  supportedWorkflowContractVersion,
  workflowBuildManifestVersion,
  workflowSdkPackage,
  workflowSdkVersion,
  workflowVerifierPackage,
  workflowVerifierVersion,
  type HashInput,
  type WorkflowBuildManifest,
} from './receipt.js';
import {
  hashDescriptor,
  type StructureDiagnostic,
  type WorkflowStructureDescriptor,
} from './structure.js';

const outputLimit = 128 * 1024;
const subprocessTimeoutMs = 120_000;
export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}
export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}
export type ProcessRunner = (spec: ProcessSpec) => Promise<ProcessResult>;

class VerificationError extends Error {}

export async function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    let timedOut = false;
    const append = (current: Buffer, chunk: Buffer) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > outputLimit) {
        overflow = true;
        return next.subarray(0, outputLimit);
      }
      return next;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child.pid);
    }, spec.timeoutMs ?? subprocessTimeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new VerificationError(`Could not start ${spec.command}: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = [stderr.toString('utf8'), stdout.toString('utf8')].filter(Boolean).join('\n');
      if (timedOut)
        return reject(
          new VerificationError(
            `${spec.command} timed out after ${spec.timeoutMs ?? subprocessTimeoutMs}ms.\n${output}`,
          ),
        );
      if (overflow)
        return reject(
          new VerificationError(
            `${spec.command} produced more than ${outputLimit} bytes of output, which the verifier refuses to process.`,
          ),
        );
      if (signal)
        return reject(
          new VerificationError(`${spec.command} terminated by signal ${signal}.\n${output}`),
        );
      if (code !== 0)
        return reject(
          new VerificationError(`${spec.command} exited with code ${code}.\n${output}`),
        );
      resolveResult({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}

function terminateTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32')
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 1_000).unref();
}

/**
 * The verifier front-runs the runtime loader: its gates mirror the checks the Isagi runtime
 * performs before importing a workflow, and it also checks the command() manifest, so failures
 * surface at authoring time instead of load or launch time. Quality gates (typecheck, tests) are deliberately absent — they are the author's
 * responsibility and do not affect whether the runtime can load the artifact.
 */
export async function verifyWorkflow(
  workflowArgument: string,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  const root = resolve(workflowArgument);
  // Remove any receipt an earlier run left behind before any work that can fail, so a failed
  // verification can never leave a previous success standing as if it certified this attempt. The
  // explicit --workflow argument already scopes this to one path, and nothing else is touched.
  await removeStaleReceipt(root);
  const packageJson = await readPackageJson(root);
  requirePins(packageJson);
  const sourceHash = hashWorkflowInputs(await readSourceInputs(root));
  const artifactPath = join(root, 'dist', 'index.js');
  const artifactBytes = await readArtifact(artifactPath);
  const descriptor = await validateArtifact(root, artifactPath, runner);

  const manifest: WorkflowBuildManifest = {
    manifestVersion: workflowBuildManifestVersion,
    workflowContractVersion: supportedWorkflowContractVersion,
    sdk: { name: workflowSdkPackage, version: workflowSdkVersion },
    verifier: { name: workflowVerifierPackage, version: workflowVerifierVersion },
    source: { sha256: sourceHash },
    artifact: { entry: 'dist/index.js', sha256: hashArtifact(artifactBytes) },
    structure: {
      descriptorVersion: descriptor.descriptorVersion,
      sha256: hashDescriptor(descriptor),
      rootGraphKey: descriptor.rootGraphKey,
      graphCount: descriptor.graphs.length,
    },
  };
  await writeAtomic(
    join(root, 'dist', 'isagi-workflow-build.json'),
    serializeWorkflowBuildManifest(manifest),
    'the build receipt',
  );
}

function receiptPath(root: string): string {
  return join(root, 'dist', 'isagi-workflow-build.json');
}

async function removeStaleReceipt(root: string): Promise<void> {
  try {
    await unlink(receiptPath(root));
  } catch (cause) {
    // Absence is the normal case. Anything else — a permission problem, a directory in its place —
    // must fail here rather than leave a misleading receipt in reach.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new VerificationError(
      `Could not remove the previous build receipt ${receiptPath(root)}: ${message(cause)}`,
    );
  }
}

function formatDiagnostics(diagnostics: readonly StructureDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const at = [
        diagnostic.at.graphKey && `graph ${diagnostic.at.graphKey}`,
        diagnostic.at.nodeId && `node ${diagnostic.at.nodeId}`,
        diagnostic.at.edgeId && `edge ${diagnostic.at.edgeId}`,
        diagnostic.at.outcomeId && `outcome ${diagnostic.at.outcomeId}`,
        diagnostic.at.field && `field ${diagnostic.at.field}`,
      ]
        .filter(Boolean)
        .join(' · ');
      return `  [${diagnostic.code}]${at ? ` ${at}:` : ''} ${diagnostic.message}`;
    })
    .join('\n');
}

async function writeAtomic(path: string, contents: string, what: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new VerificationError(`Could not write ${what} ${path}: ${message(cause)}`);
  }
}

async function readPackageJson(root: string): Promise<Record<string, any>> {
  const path = join(root, 'package.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new VerificationError(
      `Could not read ${path}. Pass the workflow package root (the directory containing package.json) to --workflow. (${message(cause)})`,
    );
  }
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch (cause) {
    throw new VerificationError(`package.json contains invalid JSON: ${message(cause)}`);
  }
}

function requirePins(packageJson: Record<string, any>): void {
  const sdkPin = packageJson.dependencies?.[workflowSdkPackage];
  if (sdkPin !== workflowSdkVersion)
    throw new VerificationError(
      `dependencies["${workflowSdkPackage}"] must be exactly "${workflowSdkVersion}"; found ${found(sdkPin)}. The Isagi runtime refuses to load a workflow whose pin differs from its build receipt.`,
    );
  const verifierPin = packageJson.devDependencies?.[workflowVerifierPackage];
  if (verifierPin !== workflowVerifierVersion)
    throw new VerificationError(
      `devDependencies["${workflowVerifierPackage}"] must be exactly "${workflowVerifierVersion}"; found ${found(verifierPin)}. The Isagi runtime refuses to load a workflow whose pin differs from its build receipt.`,
    );
}

function found(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}

async function readSourceInputs(root: string): Promise<HashInput[]> {
  const paths = ['package.json'];
  if (await exists(join(root, 'tsconfig.json'))) paths.push('tsconfig.json');
  await walk(root, 'src', paths, { required: true });
  await walk(root, 'tests', paths, { required: false });
  const inputs: HashInput[] = [];
  for (const path of paths) {
    if (!isWorkflowSourcePath(path)) continue;
    const absolute = join(root, ...path.split('/'));
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new VerificationError(symlinkMessage(path));
    if (!info.isFile())
      throw new VerificationError(
        `${path} must be a regular file so it can be fingerprinted into the build receipt.`,
      );
    inputs.push({ path, bytes: await readFile(absolute) });
  }
  return inputs;
}

function symlinkMessage(path: string): string {
  return `Symlinks are unsupported in workflow packages: ${path}. The Isagi runtime refuses symlinked sources; replace it with a regular file or directory.`;
}

async function walk(
  root: string,
  directory: string,
  output: string[],
  options: { required: boolean },
): Promise<void> {
  const absolute = join(root, directory);
  let info;
  try {
    info = await lstat(absolute);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new VerificationError(`Could not read ${directory}/: ${message(cause)}`);
    if (!options.required) return;
    throw new VerificationError(
      `A ${directory}/ directory is required: the workflow sources live there and are fingerprinted into the build receipt. Check that --workflow points at the workflow package root.`,
    );
  }
  if (info.isSymbolicLink()) throw new VerificationError(symlinkMessage(directory));
  if (!info.isDirectory())
    throw new VerificationError(`${directory} must be a directory, not a file.`);
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new VerificationError(symlinkMessage(path));
    if (entry.isDirectory()) await walk(root, path, output, { required: true });
    else if (entry.isFile()) output.push(path);
    else
      throw new VerificationError(
        `Unsupported filesystem entry (not a regular file or directory): ${path}. Remove it; only regular files can be fingerprinted into the build receipt.`,
      );
  }
}

async function readArtifact(path: string): Promise<Buffer> {
  let info;
  try {
    info = await lstat(path);
  } catch (cause) {
    throw new VerificationError(
      "Workflow build output dist/index.js is missing. Run the package's build script before verification; the verifier never compiles on the author's behalf.",
      { cause },
    );
  }
  if (info.isSymbolicLink() || !info.isFile())
    throw new VerificationError(
      "dist/index.js must be a regular file, not a symlink or directory. Re-run the package's build script to regenerate it.",
    );
  return readFile(path);
}

/**
 * Imports the built artifact in an isolated child process the way the runtime loader will, reads
 * its declared structure, and checks the exported workflow definition and its command() manifest.
 * The child (`validate-artifact.ts`) reports through a result file rather than stdout, so workflow
 * code that logs during import or command() cannot corrupt the report.
 */
async function validateArtifact(
  root: string,
  artifact: string,
  runner: ProcessRunner,
): Promise<WorkflowStructureDescriptor> {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'isagi-workflow-validation-'));
  try {
    const isolatedArtifact = join(isolatedRoot, 'index.mjs');
    await writeFile(isolatedArtifact, await readFile(artifact));
    const resultPath = join(isolatedRoot, 'result.json');
    try {
      await runner({
        command: process.execPath,
        args: [validatorPath(), isolatedArtifact, resultPath, root],
        cwd: isolatedRoot,
        timeoutMs: 10_000,
      });
    } catch (cause) {
      throw new VerificationError(
        `dist/index.js failed the artifact check: the bundle crashed the validation process instead of completing. Module-level code in the bundle must settle without crashing, exiting, or hanging.\n${message(cause)}`,
      );
    }
    let report: unknown;
    try {
      report = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch {
      throw new VerificationError(
        'dist/index.js failed the artifact check: the bundle terminated the validation process (for example via process.exit) before the check finished. Workflow code must not exit the process.',
      );
    }
    if (!report || typeof report !== 'object' || (report as { ok?: unknown }).ok !== true) {
      const diagnostics = (report as { diagnostics?: readonly StructureDiagnostic[] })?.diagnostics;
      const detail =
        Array.isArray(diagnostics) && diagnostics.length > 0
          ? formatDiagnostics(diagnostics)
          : String((report as { error?: unknown })?.error ?? 'The validation report is malformed.');
      throw new VerificationError(
        `dist/index.js failed the artifact check that mirrors how the Isagi runtime loads workflows:\n${detail}\nFix the workflow source, rebuild, and re-run verification.`,
      );
    }
    // The child returns the descriptor as data. The parent canonicalizes and hashes it itself
    // rather than trusting a hash produced inside the process that imported workflow code.
    const descriptor = (report as { descriptor?: unknown }).descriptor;
    if (!descriptor || typeof descriptor !== 'object') {
      throw new VerificationError(
        'dist/index.js failed the artifact check: the validation process reported success without a structure description.',
      );
    }
    return descriptor as WorkflowStructureDescriptor;
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

/**
 * The installed validation child (`validate-artifact.ts`), resolved as a real file path next to
 * this module so a packed installation works outside this monorepo. CLI integration tests therefore
 * run against the built CLI, whose sibling is `dist`.
 */
function validatorPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'validate-artifact.js');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  if (args.length !== 2 || args[0] !== '--workflow' || !args[1])
    throw new VerificationError('Usage: isagi-workflow-verify --workflow <exact-directory>');
  await verifyWorkflow(args[1]);
  process.stdout.write('Workflow verified. Build receipt is ready.\n');
}
