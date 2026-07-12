#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  hashArtifact,
  hashWorkflowInputs,
  isWorkflowSourcePath,
  serializeWorkflowBuildManifest,
  supportedWorkflowContractVersion,
  supportedWorkflowLockfiles,
  unsupportedWorkflowLockfiles,
  workflowBuildManifestVersion,
  workflowLockfileByPackageManager,
  workflowSdkPackage,
  workflowSdkVersion,
  workflowVerifierPackage,
  workflowVerifierVersion,
  type HashInput,
  type PackageManagerName,
  type WorkflowBuildManifest,
} from './receipt.js';

const outputLimit = 128 * 1024;
const subprocessTimeoutMs = 120_000;
const exactVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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
 * The verifier front-runs the runtime loader: every gate here mirrors a check the Isagi runtime
 * performs before importing a workflow, so failures surface at authoring time instead of load
 * time. Quality gates (typecheck, tests) are deliberately absent — they are the author's
 * responsibility and do not affect whether the runtime can load the artifact.
 */
export async function verifyWorkflow(
  workflowArgument: string,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  const root = resolve(workflowArgument);
  const packageJson = await readPackageJson(root);
  const declared = readPackageManagerDeclaration(packageJson);
  requirePins(packageJson);
  await requireLockfile(root, declared.name);
  const sourceHash = hashWorkflowInputs(await readSourceInputs(root, declared.name));
  const artifactPath = join(root, 'dist', 'index.js');
  const artifactBytes = await readArtifact(artifactPath);
  await validateArtifact(root, artifactPath, runner);
  const manifest: WorkflowBuildManifest = {
    manifestVersion: workflowBuildManifestVersion,
    workflowContractVersion: supportedWorkflowContractVersion,
    sdk: { name: workflowSdkPackage, version: workflowSdkVersion },
    verifier: { name: workflowVerifierPackage, version: workflowVerifierVersion },
    toolchain: {
      nodeVersion: process.versions.node,
      packageManager: { name: declared.name, version: declared.version },
    },
    source: { sha256: sourceHash },
    artifact: { entry: 'dist/index.js', sha256: hashArtifact(artifactBytes) },
  };
  await writeReceipt(root, manifest);
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

function readPackageManagerDeclaration(packageJson: Record<string, any>): {
  name: PackageManagerName;
  version: string;
} {
  const declaration = packageJson.packageManager;
  const rule =
    'package.json must declare "packageManager" as an exact pnpm@, npm@, or bun@ version, for example "pnpm@11.4.0". The Isagi runtime rejects workflow packages whose declaration differs from the build receipt.';
  if (typeof declaration !== 'string') throw new VerificationError(`${rule} The field is missing.`);
  const match = /^(pnpm|npm|bun)@(.+)$/.exec(declaration);
  if (!match || !exactVersion.test(match[2]!))
    throw new VerificationError(`${rule} Found "${declaration}".`);
  return { name: match[1] as PackageManagerName, version: match[2]! };
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

async function requireLockfile(root: string, manager: PackageManagerName): Promise<void> {
  const expected = workflowLockfileByPackageManager[manager];
  const present: string[] = [];
  for (const lockfile of [...supportedWorkflowLockfiles, ...unsupportedWorkflowLockfiles])
    if (await exists(join(root, lockfile))) present.push(lockfile);
  if (present.length === 1 && present[0] === expected) return;
  const hint = present.includes('bun.lockb')
    ? ' bun.lockb is the legacy binary format; delete it and let bun write bun.lock.'
    : '';
  throw new VerificationError(
    `Exactly one ${expected} lockfile is required because packageManager declares ${manager}; found ${present.join(', ') || 'none'}. Remove the others, and run the ${manager} install command if ${expected} is missing.${hint}`,
  );
}

async function readSourceInputs(root: string, manager: PackageManagerName): Promise<HashInput[]> {
  const paths = ['package.json', workflowLockfileByPackageManager[manager]];
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
 * Imports the built artifact in an isolated child process the way the runtime loader will, and
 * checks the exported workflow definition and its command() manifest. The child reports through a
 * result file rather than stdout, so workflow code that logs during import or command() cannot
 * corrupt the report.
 */
async function validateArtifact(
  root: string,
  artifact: string,
  runner: ProcessRunner,
): Promise<void> {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'isagi-workflow-validation-'));
  try {
    const isolatedArtifact = join(isolatedRoot, 'index.mjs');
    await writeFile(isolatedArtifact, await readFile(artifact));
    const resultPath = join(isolatedRoot, 'result.json');
    const validatorPath = join(isolatedRoot, 'validate.mjs');
    await writeFile(validatorPath, validatorSource(isolatedArtifact, resultPath, root));
    try {
      await runner({
        command: process.execPath,
        args: [validatorPath],
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
    if (!report || typeof report !== 'object' || (report as { ok?: unknown }).ok !== true)
      throw new VerificationError(
        `dist/index.js failed the artifact check that mirrors how the Isagi runtime loads workflows:\n${String((report as { error?: unknown })?.error ?? 'The validation report is malformed.')}\nFix the workflow source, rebuild, and re-run verification.`,
      );
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

function validatorSource(artifactPath: string, resultPath: string, worktreePath: string): string {
  return [
    `import { writeFileSync } from 'node:fs';`,
    `const finish = (report) => { writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(report)); process.exit(0); };`,
    `const describe = (value) => (Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value);`,
    `const cause = (error) => String((error && error.stack) || error);`,
    `let artifact;`,
    `try { artifact = await import(${JSON.stringify(pathToFileURL(artifactPath).href)}); }`,
    `catch (error) { finish({ ok: false, error: 'Importing the bundle threw before any workflow definition could be read:\\n' + cause(error) }); }`,
    `const workflow = artifact.default;`,
    `if (!workflow || typeof workflow !== 'object') finish({ ok: false, error: 'The bundle must default-export the workflow definition object returned by defineWorkflow(); its default export is ' + describe(workflow) + '.' });`,
    `const missing = ['command', 'validate', 'init', 'step'].filter((name) => typeof workflow[name] !== 'function');`,
    `if (missing.length) finish({ ok: false, error: 'The default-exported workflow definition is missing required function(s): ' + missing.join(', ') + '. Default-export the object returned by defineWorkflow() from src/index.ts.' });`,
    `let manifest;`,
    `try { manifest = await workflow.command({ worktreeId: 0, worktreePath: ${JSON.stringify(worktreePath)}, surfaceId: 0, paneId: null, agentSessionId: null }); }`,
    `catch (error) { finish({ ok: false, error: 'command() threw when called with a minimal launch context. command() must succeed without optional pane or agent-session context.\\n' + cause(error) }); }`,
    `const problems = [];`,
    `if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) problems.push('command() must return a manifest object; it returned ' + describe(manifest) + '.');`,
    `else {`,
    `  if (typeof manifest.title !== 'string' || !manifest.title) problems.push('command() must return a manifest with a non-empty string title; found ' + describe(manifest.title) + '.');`,
    `  if (manifest.description !== undefined && typeof manifest.description !== 'string') problems.push('command() manifest description must be a string when present; found ' + describe(manifest.description) + '.');`,
    `  if (manifest.inputs !== undefined && !Array.isArray(manifest.inputs)) problems.push('command() manifest inputs must be an array when present; found ' + describe(manifest.inputs) + '.');`,
    `  for (const [index, input] of (Array.isArray(manifest.inputs) ? manifest.inputs : []).entries()) {`,
    `    const where = 'inputs[' + index + ']' + (input && typeof input.key === 'string' && input.key ? ' (key "' + input.key + '")' : '');`,
    `    if (!input || typeof input !== 'object') { problems.push('command() ' + where + ' must be an input object; found ' + describe(input) + '.'); continue; }`,
    `    if (!['text', 'select', 'multi-select', 'confirm'].includes(input.kind)) problems.push('command() ' + where + ' has kind ' + JSON.stringify(input.kind) + '; expected "text", "select", "multi-select", or "confirm".');`,
    `    if (typeof input.key !== 'string' || !input.key) problems.push('command() ' + where + ' needs a non-empty string key.');`,
    `    if (typeof input.label !== 'string' || !input.label) problems.push('command() ' + where + ' needs a non-empty string label.');`,
    `    if (input.kind === 'select' || input.kind === 'multi-select') {`,
    `      if (!Array.isArray(input.options)) problems.push('command() ' + where + ' is a ' + input.kind + ' input and needs an options array.');`,
    `      else for (const [optionIndex, option] of input.options.entries()) if (!option || typeof option.value !== 'string') problems.push('command() ' + where + ' options[' + optionIndex + '] needs a string value.');`,
    `    }`,
    `  }`,
    `}`,
    `finish(problems.length ? { ok: false, error: problems.join('\\n') } : { ok: true });`,
    ``,
  ].join('\n');
}

async function writeReceipt(root: string, manifest: WorkflowBuildManifest): Promise<void> {
  const receiptPath = join(root, 'dist', 'isagi-workflow-build.json');
  const temporary = `${receiptPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serializeWorkflowBuildManifest(manifest), { flag: 'wx' });
    await rename(temporary, receiptPath);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new VerificationError(
      `Could not write the build receipt ${receiptPath}: ${message(cause)}`,
    );
  }
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
