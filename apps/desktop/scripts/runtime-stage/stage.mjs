import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import process from 'node:process';

import { Effect } from 'effect';

import {
  runtimeNativeExternals,
  runtimePackageExternals,
} from '../../../runtime/runtime-externals.mjs';
import { StageOperationError, StageValidationError } from './errors.mjs';
import {
  electronBuildCacheRoot,
  generatedRoot,
  nativeCacheRoot,
  pnpmfilePath,
  rebuildWorkerPath,
  repoRoot,
  runtimeRoot,
  stageBackupRoot,
  stageRoot,
} from './paths.mjs';
import { runCommand } from './process.mjs';

export const stagingRecipeVersion = 1;
const completionFileName = 'runtime-native-cache.json';
const stageMetadataFileName = 'runtime-stage.json';

export function prepareRuntimeStage({ forceNative = false } = {}) {
  return Effect.gen(function* () {
    yield* tryOperation('recovery', generatedRoot, () => recoverGeneratedState());
    yield* runCommand('pnpm', ['--filter', '@isagi/runtime', 'build'], { cwd: repoRoot });

    const electron = yield* readElectronRuntime();
    const dependencyVersions = yield* tryOperation('dependency resolution', runtimeRoot, () =>
      resolveExternalVersions(runtimeRoot),
    );
    const rebuildVersion = yield* tryOperation('rebuild version resolution', repoRoot, () =>
      resolvePackageVersion('@electron/rebuild', resolve(repoRoot, 'apps/desktop/package.json')),
    );
    const fingerprintInputs = yield* tryOperation('fingerprint calculation', repoRoot, () =>
      createFingerprintInputs({ electron, dependencyVersions, rebuildVersion }),
    );
    const fingerprint = createFingerprint(fingerprintInputs);
    const cache = yield* prepareNativeCache({
      dependencyVersions,
      electron,
      fingerprint,
      fingerprintInputs,
      forceNative,
    });
    const nextRoot = `${stageRoot}.next-${randomUUID()}`;

    yield* tryOperation('assembly', nextRoot, () => {
      assembleStage({
        cacheRoot: cache.path,
        dependencyVersions,
        electron,
        fingerprint,
        nextRoot,
      });
      validateStage(nextRoot, dependencyVersions);
      publishStage(nextRoot);
    });

    console.log(
      `[desktop] Runtime stage ready at ${stageRoot} (native cache ${cache.hit ? 'hit' : 'rebuilt'}: ${fingerprint.slice(0, 12)})`,
    );
    return { cacheHit: cache.hit, electron, fingerprint, path: stageRoot };
  });
}

export function createFingerprint(inputs) {
  return createHash('sha256').update(stableJson(inputs)).digest('hex');
}

export function createFingerprintInputs({ electron, dependencyVersions, rebuildVersion }) {
  const lockfile = readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'));
  return {
    dependencyVersions,
    electron: {
      abi: electron.abi,
      arch: electron.arch,
      node: electron.node,
      platform: electron.platform,
      version: electron.version,
    },
    libc: linuxLibcIdentity(),
    lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
    rebuildVersion,
    runtimeNativeExternals,
    runtimePackageExternals,
    stagingRecipeVersion,
  };
}

export function recoverGeneratedState(paths = {}) {
  const root = paths.generatedRoot ?? generatedRoot;
  const published = paths.stageRoot ?? stageRoot;
  const backup = paths.stageBackupRoot ?? stageBackupRoot;
  const caches = paths.nativeCacheRoot ?? nativeCacheRoot;
  mkdirSync(root, { recursive: true });
  for (const name of readdirSync(root)) {
    if (name.startsWith(`${basename(published)}.next-`)) {
      rmSync(resolve(root, name), { recursive: true, force: true });
    }
  }

  if (!existsSync(published) && existsSync(backup)) {
    renameSync(backup, published);
  } else if (existsSync(published) && existsSync(backup)) {
    rmSync(backup, { recursive: true, force: true });
  }

  mkdirSync(caches, { recursive: true });
  for (const name of readdirSync(caches)) {
    if (name.startsWith('.next-')) {
      rmSync(resolve(caches, name), { recursive: true, force: true });
    }
  }
}

function prepareNativeCache({
  dependencyVersions,
  electron,
  fingerprint,
  fingerprintInputs,
  forceNative,
}) {
  return Effect.gen(function* () {
    const cachePath = resolve(nativeCacheRoot, fingerprint);
    if (forceNative) {
      yield* tryOperation('forced native cache removal', cachePath, () =>
        rmSync(cachePath, { recursive: true, force: true }),
      );
    }

    const valid = yield* tryOperation('native cache inspection', cachePath, () =>
      isValidNativeCache(cachePath, fingerprint, dependencyVersions),
    );
    if (valid) return { hit: true, path: cachePath };

    yield* tryOperation('stale native cache removal', cachePath, () =>
      rmSync(cachePath, { recursive: true, force: true }),
    );
    const nextCache = resolve(nativeCacheRoot, `.next-${fingerprint}-${randomUUID()}`);
    const deployArgs = [
      '--filter',
      '@isagi/runtime',
      'deploy',
      nextCache,
      '--legacy',
      '--prod',
      '--offline',
      '--config.minimum-release-age=0',
      '--config.minimum-release-age-strict=false',
      '--config.package-import-method=copy',
      '--pnpmfile',
      pnpmfilePath,
    ];

    yield* runCommand('pnpm', deployArgs, { cwd: repoRoot }).pipe(
      Effect.mapError(
        (cause) =>
          new StageOperationError({
            operation:
              'lockfile dependency materialization; run pnpm install if the local pnpm store is incomplete',
            path: nextCache,
            cause,
          }),
      ),
    );
    yield* tryOperation('deployed manifest projection', nextCache, () => {
      removeNonDependencyDeployFiles(nextCache);
      removeExternalSymlinks(nextCache);
      writeJson(resolve(nextCache, 'package.json'), stagedPackageManifest(dependencyVersions));
      validateDependencyTree(nextCache, dependencyVersions, { requireNativeArtifacts: false });
      assertNoExternalSymlinks(nextCache);
    });

    mkdirSync(electronBuildCacheRoot, { recursive: true });
    const rebuildEnvironment = {
      ...process.env,
      HOME: electronBuildCacheRoot,
      USERPROFILE: electronBuildCacheRoot,
    };
    yield* runCommand(
      process.execPath,
      [
        rebuildWorkerPath,
        JSON.stringify({
          arch: electron.arch,
          buildPath: nextCache,
          electronVersion: electron.version,
          onlyModules: runtimeNativeExternals,
          platform: electron.platform,
          projectRootPath: nextCache,
        }),
      ],
      { cwd: repoRoot, env: rebuildEnvironment },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new StageOperationError({
            operation: `Electron ${electron.version} native rebuild for ${runtimeNativeExternals.join(', ')}`,
            path: nextCache,
            cause,
          }),
      ),
    );

    yield* tryOperation('native cache validation', nextCache, () => {
      validateDependencyTree(nextCache, dependencyVersions, { requireNativeArtifacts: true });
      writeJson(resolve(nextCache, completionFileName), {
        completed: true,
        dependencyVersions,
        fingerprint,
        fingerprintInputs,
        nativeModules: runtimeNativeExternals,
        recipeVersion: stagingRecipeVersion,
      });
      renameSync(nextCache, cachePath);
    });

    return { hit: false, path: cachePath };
  });
}

function readElectronRuntime() {
  return Effect.gen(function* () {
    const desktopManifest = resolve(repoRoot, 'apps/desktop/package.json');
    const require = createRequire(desktopManifest);
    const executable = require('electron');
    const version = resolvePackageVersion('electron', desktopManifest);
    const source =
      'console.log(JSON.stringify({version:process.versions.electron,node:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch}))';
    const result = yield* runCommand(executable, ['-e', source], {
      capture: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: 15_000,
    });
    const reported = yield* tryOperation('Electron runtime inspection', executable, () =>
      JSON.parse(result.stdout.trim()),
    );
    if (
      reported.version !== version ||
      reported.platform !== process.platform ||
      reported.arch !== process.arch
    ) {
      return yield* Effect.fail(
        new StageValidationError({
          path: executable,
          reason: `installed Electron ${version}/${process.platform}/${process.arch} does not match executable ${reported.version}/${reported.platform}/${reported.arch}`,
        }),
      );
    }
    return { ...reported, executable };
  });
}

function assembleStage({ cacheRoot, dependencyVersions, electron, fingerprint, nextRoot }) {
  rmSync(nextRoot, { recursive: true, force: true });
  mkdirSync(nextRoot, { recursive: true });
  cpSync(resolve(runtimeRoot, 'dist'), nextRoot, {
    recursive: true,
    verbatimSymlinks: true,
  });
  cpSync(resolve(runtimeRoot, 'drizzle'), resolve(nextRoot, 'drizzle'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  cpSync(resolve(cacheRoot, 'node_modules'), resolve(nextRoot, 'node_modules'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  writeJson(resolve(nextRoot, 'package.json'), stagedPackageManifest(dependencyVersions));
  writeJson(resolve(nextRoot, stageMetadataFileName), {
    dependencyVersions,
    electron: {
      abi: electron.abi,
      arch: electron.arch,
      node: electron.node,
      platform: electron.platform,
      version: electron.version,
    },
    entrypoint: 'index.js',
    fingerprint,
    layoutVersion: 1,
  });
}

function publishStage(nextRoot) {
  rmSync(stageBackupRoot, { recursive: true, force: true });
  if (existsSync(stageRoot)) renameSync(stageRoot, stageBackupRoot);
  try {
    renameSync(nextRoot, stageRoot);
  } catch (cause) {
    if (!existsSync(stageRoot) && existsSync(stageBackupRoot)) {
      renameSync(stageBackupRoot, stageRoot);
    }
    throw cause;
  }
  rmSync(stageBackupRoot, { recursive: true, force: true });
}

export function validateStage(root, dependencyVersions) {
  for (const required of [
    'index.js',
    'assets/manifest.json',
    'drizzle/meta/_journal.json',
    'package.json',
    stageMetadataFileName,
  ]) {
    const path = resolve(root, required);
    if (!existsSync(path)) {
      throw new StageValidationError({
        path,
        reason: `required staged file ${required} is missing`,
      });
    }
  }
  validateDependencyTree(root, dependencyVersions, { requireNativeArtifacts: true });
  assertNoExternalSymlinks(root);
  assertNoAbsoluteMetadataPaths(resolve(root, stageMetadataFileName));
}

export function isValidNativeCache(root, fingerprint, dependencyVersions) {
  if (!existsSync(root)) return false;
  try {
    const completion = readJson(resolve(root, completionFileName));
    if (
      completion.completed !== true ||
      completion.fingerprint !== fingerprint ||
      completion.recipeVersion !== stagingRecipeVersion ||
      stableJson(completion.dependencyVersions) !== stableJson(dependencyVersions)
    ) {
      return false;
    }
    validateDependencyTree(root, dependencyVersions, { requireNativeArtifacts: true });
    assertNoExternalSymlinks(root);
    return true;
  } catch {
    return false;
  }
}

export function validateDependencyTree(root, dependencyVersions, { requireNativeArtifacts }) {
  const manifest = readJson(resolve(root, 'package.json'));
  if (stableJson(manifest.dependencies) !== stableJson(dependencyVersions)) {
    throw new StageValidationError({
      path: resolve(root, 'package.json'),
      reason: 'staged dependencies do not match the runtime external declaration',
    });
  }
  const require = createRequire(resolve(root, 'package.json'));
  for (const name of runtimePackageExternals) {
    let entry;
    try {
      entry = require.resolve(name);
    } catch (cause) {
      throw new StageOperationError({
        operation: `dependency resolution for ${name}`,
        path: root,
        cause,
      });
    }
    const packageRoot = findPackageRoot(entry, name);
    assertPathInsideRoot(root, entry, `${name} entrypoint`);
    assertPathInsideRoot(root, packageRoot, `${name} package root`);
    if (requireNativeArtifacts && runtimeNativeExternals.includes(name)) {
      const nativeFiles = walk(packageRoot).filter((path) => path.endsWith('.node'));
      if (nativeFiles.length === 0) {
        throw new StageValidationError({
          path: packageRoot,
          reason: `${name} has no native artifact`,
        });
      }
    }
  }
}

function assertPathInsideRoot(root, path, description) {
  const resolvedRoot = realpathSync(root);
  const resolvedPath = realpathSync(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new StageValidationError({
      path: resolvedPath,
      reason: `${description} resolves outside the staged tree rooted at ${resolvedRoot}`,
    });
  }
}

function resolveExternalVersions(fromRoot) {
  return Object.fromEntries(
    runtimePackageExternals.map((name) => [
      name,
      resolvePackageVersion(name, resolve(fromRoot, 'package.json')),
    ]),
  );
}

function resolvePackageVersion(name, fromManifest) {
  const require = createRequire(fromManifest);
  const entry = require.resolve(name);
  return readJson(resolve(findPackageRoot(entry, name), 'package.json')).version;
}

function findPackageRoot(entry, expectedName) {
  let current = dirname(entry);
  while (true) {
    const manifestPath = resolve(current, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      if (manifest.name === expectedName) return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new StageValidationError({ path: entry, reason: `could not locate ${expectedName}` });
    }
    current = parent;
  }
}

function stagedPackageManifest(dependencyVersions) {
  return {
    name: '@isagi/electron-runtime-stage',
    version: readJson(resolve(runtimeRoot, 'package.json')).version,
    private: true,
    type: 'module',
    main: 'index.js',
    dependencies: dependencyVersions,
  };
}

function removeNonDependencyDeployFiles(root) {
  for (const name of readdirSync(root)) {
    if (name !== 'node_modules' && name !== 'package.json') {
      rmSync(resolve(root, name), { recursive: true, force: true });
    }
  }
}

function removeExternalSymlinks(root) {
  const realRoot = `${realpathSync(root)}${sep}`;
  for (const path of walk(root, { includeSymlinks: true })) {
    if (!lstatSync(path).isSymbolicLink()) continue;
    const target = realpathSync(path);
    if (target !== realRoot.slice(0, -1) && !target.startsWith(realRoot)) {
      rmSync(path, { force: true });
    }
  }
}

function assertNoExternalSymlinks(root) {
  const realRoot = `${realpathSync(root)}${sep}`;
  for (const path of walk(root, { includeSymlinks: true })) {
    if (!lstatSync(path).isSymbolicLink()) continue;
    const target = realpathSync(path);
    if (target !== realRoot.slice(0, -1) && !target.startsWith(realRoot)) {
      throw new StageValidationError({
        path,
        reason: `symlink escapes the staged tree (${readlinkSync(path)})`,
      });
    }
  }
}

function assertNoAbsoluteMetadataPaths(path) {
  const visit = (value) => {
    if (typeof value === 'string' && isAbsolute(value)) {
      throw new StageValidationError({ path, reason: `metadata contains absolute path ${value}` });
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(readJson(path));
}

function walk(root, { includeSymlinks = false } = {}) {
  const results = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) {
      if (includeSymlinks) results.push(path);
    } else if (entry.isDirectory()) {
      results.push(...walk(path, { includeSymlinks }));
    } else if (entry.isFile()) {
      results.push(path);
    }
  }
  return results;
}

function linuxLibcIdentity() {
  if (process.platform !== 'linux') return null;
  const report = process.report?.getReport();
  const glibc = report?.header?.glibcVersionRuntime;
  return glibc ? `glibc-${glibc}` : 'musl-or-unknown';
}

function tryOperation(operation, path, run) {
  return Effect.try({
    try: run,
    catch: (cause) => (cause?._tag ? cause : new StageOperationError({ operation, path, cause })),
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortObject(child)]),
  );
}
