#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

import {
  hashArtifact,
  hashWorkflowInputs,
  isWorkflowSourcePath,
  serializeWorkflowBuildManifest,
  supportedWorkflowContractVersion,
  verifierReservedPrefix,
  workflowBuildManifestVersion,
  workflowSdkPackage,
  workflowSdkVersion,
  workflowVerifierPackage,
  workflowVerifierVersion,
  workflowLockfileByPackageManager,
  supportedWorkflowLockfiles,
  unsupportedWorkflowLockfiles,
  type HashInput,
  type PackageManagerName,
  type WorkflowBuildManifest,
} from './receipt.js';

const lockName = `${verifierReservedPrefix}lock`;
const transactionPrefix = `${verifierReservedPrefix}transaction-`;
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
      const out = stdout.toString('utf8');
      const err = stderr.toString('utf8');
      if (timedOut)
        return reject(
          new VerificationError(
            `${spec.command} timed out after ${spec.timeoutMs ?? subprocessTimeoutMs}ms.\n${err}`,
          ),
        );
      if (overflow)
        return reject(
          new VerificationError(`${spec.command} exceeded the ${outputLimit}-byte output limit.`),
        );
      if (signal)
        return reject(
          new VerificationError(`${spec.command} terminated by signal ${signal}.\n${err}`),
        );
      if (code !== 0)
        return reject(
          new VerificationError(`${spec.command} exited with code ${code}.\n${err || out}`),
        );
      resolveResult({ stdout: out, stderr: err });
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

interface PackageFacts {
  readonly manager: PackageManagerName;
  readonly managerVersion: string;
  readonly runner: { command: string; argsPrefix: readonly string[] };
}

export async function verifyWorkflow(
  workflowArgument: string,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  const root = resolve(workflowArgument);
  const lockPath = join(root, lockName);
  const lock = await acquireLock(lockPath);
  let transaction = '';
  let backup = '';
  let distMoved = false;
  let publicationStarted = false;
  let failure: unknown;
  try {
    const leftovers = (await readdir(root)).filter((name) => name.startsWith(transactionPrefix));
    if (leftovers.length)
      throw new VerificationError(
        `Verifier transaction evidence exists (${leftovers.join(', ')}). Inspect it manually before retrying.`,
      );
    transaction = await mkdtemp(join(root, transactionPrefix));
    backup = join(transaction, 'previous-dist');
    const facts = await readPackageFacts(root, runner);
    const initialInputs = await readSourceInputs(root, facts.manager);
    const initialHash = hashWorkflowInputs(initialInputs);
    const dist = join(root, 'dist');
    if (await exists(dist)) {
      await rename(dist, backup);
      distMoved = true;
    }
    await runScript(root, facts, 'typecheck', runner);
    await runScript(root, facts, 'test', runner);
    const rechecked = await readPackageFacts(root, runner);
    if (JSON.stringify(rechecked) !== JSON.stringify(facts))
      throw new VerificationError(
        'Package-manager or installed package facts changed during verification.',
      );
    const finalHash = hashWorkflowInputs(await readSourceInputs(root, facts.manager));
    if (finalHash !== initialHash)
      throw new VerificationError('Declared workflow source inputs changed during verification.');
    const stagedDist = join(transaction, 'staged-dist');
    await mkdir(stagedDist);
    const artifactPath = join(stagedDist, 'index.js');
    await bundleWorkflow(root, artifactPath);
    await validateArtifact(root, artifactPath, runner);
    const artifactBytes = await readFile(artifactPath);
    const manifest: WorkflowBuildManifest = {
      manifestVersion: workflowBuildManifestVersion,
      workflowContractVersion: supportedWorkflowContractVersion,
      sdk: { name: workflowSdkPackage, version: workflowSdkVersion },
      verifier: { name: workflowVerifierPackage, version: workflowVerifierVersion },
      toolchain: {
        nodeVersion: process.versions.node,
        packageManager: { name: facts.manager, version: facts.managerVersion },
      },
      source: { sha256: finalHash },
      artifact: { entry: 'dist/index.js', sha256: hashArtifact(artifactBytes) },
    };
    await writeFile(
      join(stagedDist, 'isagi-workflow-build.json'),
      serializeWorkflowBuildManifest(manifest),
    );
    publicationStarted = true;
    if (await exists(dist)) await rm(dist, { recursive: true, force: true });
    await rename(stagedDist, dist);
    if (await exists(backup)) await rm(backup, { recursive: true });
    await rm(transaction, { recursive: true });
    transaction = '';
  } catch (error) {
    const recovery: string[] = [];
    try {
      if ((distMoved || publicationStarted) && (await exists(join(root, 'dist'))))
        await rm(join(root, 'dist'), { recursive: true, force: true });
    } catch (cause) {
      recovery.push(`could not remove partial dist: ${message(cause)}`);
    }
    try {
      if (distMoved && backup && (await exists(backup))) await rename(backup, join(root, 'dist'));
    } catch (cause) {
      recovery.push(`could not restore previous dist: ${message(cause)}`);
    }
    if (transaction && recovery.length === 0) {
      try {
        await rm(transaction, { recursive: true });
        transaction = '';
      } catch (cause) {
        recovery.push(`could not remove transaction: ${message(cause)}`);
      }
    }
    if (recovery.length) {
      failure = new VerificationError(
        `${message(error)}\nRecovery incomplete: ${recovery.join('; ')}. Transaction evidence was preserved.`,
      );
    } else failure = error;
  }
  try {
    await lock.close();
    await rm(lockPath);
  } catch (error) {
    const releaseFailure = `Verification lock could not be released: ${message(error)}`;
    failure = new VerificationError(
      failure ? `${message(failure)}\n${releaseFailure}` : releaseFailure,
    );
  }
  if (failure) throw failure;
}

async function acquireLock(path: string) {
  try {
    return await open(path, 'wx');
  } catch (error) {
    throw new VerificationError(
      `Could not acquire verification lock ${basename(path)}: ${message(error)}`,
    );
  }
}

async function readPackageFacts(root: string, runner: ProcessRunner): Promise<PackageFacts> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, any>;
  const declaration = pkg.packageManager;
  if (typeof declaration !== 'string')
    throw new VerificationError('packageManager must be an exact pnpm@, npm@, or bun@ version.');
  const match = /^(pnpm|npm|bun)@(.+)$/.exec(declaration);
  if (!match || !exactVersion.test(match[2]!))
    throw new VerificationError(
      `Unsupported or non-exact packageManager declaration: ${declaration}`,
    );
  const manager = match[1] as PackageManagerName;
  const managerVersion = match[2]!;
  const lockfiles = [...supportedWorkflowLockfiles, ...unsupportedWorkflowLockfiles];
  const present: string[] = [];
  for (const lockfile of lockfiles) if (await exists(join(root, lockfile))) present.push(lockfile);
  if (present.some((lockfile) => unsupportedWorkflowLockfiles.includes(lockfile as 'bun.lockb')))
    throw new VerificationError('bun.lockb is unsupported; use the modern bun.lock format.');
  const expected = workflowLockfileByPackageManager[manager];
  if (present.length !== 1 || present[0] !== expected)
    throw new VerificationError(
      `Expected exactly one ${expected} lockfile for ${manager}; found ${present.join(', ') || 'none'}.`,
    );
  requireScripts(pkg.scripts);
  requirePins(pkg);
  await validateInstalledVersion(root, workflowSdkPackage, workflowSdkVersion);
  const verifierPackageJson = await validateInstalledVersion(
    root,
    workflowVerifierPackage,
    workflowVerifierVersion,
  );
  if (verifierPackageJson.peerDependencies?.[workflowSdkPackage] !== workflowSdkVersion)
    throw new VerificationError(
      `Installed verifier must declare an exact ${workflowSdkPackage}@${workflowSdkVersion} peer dependency.`,
    );
  const runnerSpec = selectPackageManagerRunner(manager, process.env);
  const version = (
    await runner({
      command: runnerSpec.command,
      args: [...runnerSpec.argsPrefix, '--version'],
      cwd: root,
    })
  ).stdout.trim();
  if (version !== managerVersion)
    throw new VerificationError(
      `${manager} runner version ${version || '(empty)'} does not match declared ${managerVersion}.`,
    );
  return { manager, managerVersion, runner: runnerSpec };
}

export function selectPackageManagerRunner(
  declared: PackageManagerName,
  env: NodeJS.ProcessEnv,
): { command: string; argsPrefix: readonly string[] } {
  const agent = env.npm_config_user_agent;
  const execPath = env.npm_execpath;
  if (!agent && !execPath) return { command: declared, argsPrefix: [] };
  const lifecycleName = /^(pnpm|npm|bun)\//.exec(agent ?? '')?.[1] as
    | PackageManagerName
    | undefined;
  if (!lifecycleName || !execPath)
    throw new VerificationError(
      'Package-manager lifecycle metadata is incomplete or unrecognized.',
    );
  if (lifecycleName !== declared)
    throw new VerificationError(
      `Verification is running under ${lifecycleName}, but packageManager declares ${declared}.`,
    );
  return /\.[cm]?js$/.test(execPath)
    ? { command: process.execPath, argsPrefix: [execPath] }
    : { command: execPath, argsPrefix: [] };
}

async function runScript(
  root: string,
  facts: PackageFacts,
  script: 'typecheck' | 'test',
  runner: ProcessRunner,
) {
  const args = facts.manager === 'npm' ? ['run', script] : ['run', script];
  await runner({
    command: facts.runner.command,
    args: [...facts.runner.argsPrefix, ...args],
    cwd: root,
  });
}

function requireScripts(scripts: unknown): void {
  if (!scripts || typeof scripts !== 'object')
    throw new VerificationError('Workflow package scripts are missing.');
  const value = scripts as Record<string, unknown>;
  const command = 'isagi-workflow-verify --workflow .';
  for (const name of ['typecheck', 'test'])
    if (typeof value[name] !== 'string' || !value[name])
      throw new VerificationError(`Workflow script ${name} is required.`);
  for (const name of ['build', 'verify'])
    if (value[name] !== command)
      throw new VerificationError(`Workflow script ${name} must be exactly: ${command}`);
}

function requirePins(pkg: Record<string, any>): void {
  if (pkg.dependencies?.[workflowSdkPackage] !== workflowSdkVersion)
    throw new VerificationError(
      `${workflowSdkPackage} must be exactly ${workflowSdkVersion} in dependencies.`,
    );
  if (pkg.devDependencies?.[workflowVerifierPackage] !== workflowVerifierVersion)
    throw new VerificationError(
      `${workflowVerifierPackage} must be exactly ${workflowVerifierVersion} in devDependencies.`,
    );
}

async function validateInstalledVersion(
  root: string,
  name: string,
  version: string,
): Promise<Record<string, any>> {
  const pkgPath = join(root, 'node_modules', ...name.split('/'), 'package.json');
  try {
    const installed = JSON.parse(await readFile(pkgPath, 'utf8'));
    if (installed.name !== name || installed.version !== version)
      throw new Error(`found ${installed.name}@${installed.version}`);
    return installed;
  } catch (error) {
    throw new VerificationError(`Installed ${name}@${version} is required (${message(error)}).`);
  }
}

async function readSourceInputs(root: string, manager: PackageManagerName): Promise<HashInput[]> {
  const paths = [
    'package.json',
    'tsconfig.json',
    manager === 'pnpm' ? 'pnpm-lock.yaml' : manager === 'npm' ? 'package-lock.json' : 'bun.lock',
  ];
  for (const directory of ['src', 'tests']) await walk(root, directory, paths);
  const inputs: HashInput[] = [];
  for (const path of paths) {
    if (!isWorkflowSourcePath(path)) continue;
    const absolute = join(root, ...path.split('/'));
    const info = await lstat(absolute);
    if (info.isSymbolicLink())
      throw new VerificationError(`Symlinks are unsupported in workflow source inputs: ${path}`);
    if (!info.isFile())
      throw new VerificationError(`Workflow source input is not a regular file: ${path}`);
    inputs.push({ path, bytes: await readFile(absolute) });
  }
  await validateTsconfig(root);
  return inputs;
}

async function walk(root: string, directory: string, output: string[]): Promise<void> {
  const absolute = join(root, directory);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new VerificationError(`Symlinks are unsupported: ${directory}`);
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new VerificationError(`Symlinks are unsupported: ${path}`);
    if (entry.isDirectory()) await walk(root, path, output);
    else if (entry.isFile()) output.push(path);
    else throw new VerificationError(`Unsupported filesystem entry: ${path}`);
  }
}

async function validateTsconfig(root: string): Promise<void> {
  const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')) as Record<
    string,
    any
  >;
  const candidates = [
    config.extends,
    ...(Array.isArray(config.references) ? config.references.map((item: any) => item?.path) : []),
  ].filter((v): v is string => typeof v === 'string');
  for (const candidate of candidates) {
    const resolved = resolve(root, candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
      throw new VerificationError(`tsconfig reference escapes the workflow package: ${candidate}`);
  }
}

async function bundleWorkflow(root: string, outfile: string): Promise<void> {
  const entry = join(root, 'src', 'index.ts');
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    splitting: false,
    sourcemap: false,
    metafile: true,
    external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    logLevel: 'silent',
  });
  const opaqueDynamicImport = result.warnings.find(
    (warning) =>
      warning.id.includes('unsupported-dynamic-import') || warning.text.includes('dynamic import'),
  );
  if (opaqueDynamicImport)
    throw new VerificationError(
      `Opaque dynamic import is unsupported: ${opaqueDynamicImport.text}`,
    );
  const outputs = Object.keys(result.metafile.outputs);
  if (outputs.length !== 1)
    throw new VerificationError(
      `Workflow build emitted unsupported chunks or assets: ${outputs.join(', ')}`,
    );
  const native = Object.keys(result.metafile.inputs).find((path) => path.endsWith('.node'));
  if (native) throw new VerificationError(`Native addon is unsupported: ${native}`);
}

async function validateArtifact(
  root: string,
  artifact: string,
  runner: ProcessRunner,
): Promise<void> {
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'isagi-workflow-validation-'));
  try {
    const isolatedArtifact = join(isolatedRoot, 'index.mjs');
    await copyFile(artifact, isolatedArtifact);
    const validator = join(isolatedRoot, 'validate.mjs');
    await writeFile(
      validator,
      `const artifact = await import(${JSON.stringify(pathToFileURL(isolatedArtifact).href)});\nconst workflow = artifact.default;\nif (!workflow || typeof workflow !== 'object') throw new Error('Default workflow export is missing.');\nfor (const name of ['command','validate','init','step']) if (typeof workflow[name] !== 'function') throw new Error('Workflow export '+name+' must be a function.');\nconst manifest = await workflow.command({worktreeId:0,worktreePath:${JSON.stringify(root)},surfaceId:0,paneId:null,agentSessionId:null});\nif (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.title !== 'string' || !manifest.title) throw new Error('command() returned an invalid manifest.');\nif (manifest.description !== undefined && typeof manifest.description !== 'string') throw new Error('command() description must be a string.');\nif (manifest.inputs !== undefined && !Array.isArray(manifest.inputs)) throw new Error('command() inputs must be an array.');\nfor (const input of manifest.inputs ?? []) { if (!input || typeof input !== 'object' || !['text','select','multi-select','confirm'].includes(input.kind) || typeof input.key !== 'string' || !input.key || typeof input.label !== 'string' || !input.label) throw new Error('command() contains an invalid input.'); if ((input.kind === 'select' || input.kind === 'multi-select') && (!Array.isArray(input.options) || input.options.some(option => !option || typeof option.value !== 'string'))) throw new Error('command() contains invalid options.'); }\nprocess.stdout.write(JSON.stringify({protocol:1,ok:true}));\n`,
    );
    const result = await runner({
      command: process.execPath,
      args: [validator],
      cwd: isolatedRoot,
      timeoutMs: 10_000,
    });
    let protocol: unknown;
    try {
      protocol = JSON.parse(result.stdout);
    } catch {
      throw new VerificationError('Artifact validator returned malformed protocol output.');
    }
    if (
      !protocol ||
      typeof protocol !== 'object' ||
      (protocol as any).protocol !== 1 ||
      (protocol as any).ok !== true
    )
      throw new VerificationError('Artifact validator returned an invalid protocol response.');
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
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
  process.stdout.write('Workflow verified. dist is ready.\n');
}
