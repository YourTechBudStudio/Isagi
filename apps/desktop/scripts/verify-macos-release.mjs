import { spawn } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import process from 'node:process';

import { Data, Effect } from 'effect';

import { macReleaseContract } from './macos-release-contract.mjs';
import { verifyMacArchitectureMetadata } from './macos-update-metadata.mjs';
import { smokeRuntimeStage } from './runtime-stage/smoke.mjs';

const minimumIconSizes = Object.freeze([16, 32, 128, 256, 512, 1024]);

export class MacReleaseVerificationFailure extends Data.TaggedError(
  'MacReleaseVerificationFailure',
) {
  get message() {
    return this.reason;
  }
}

// Every resource this verifier acquires — the temporary tree, the extracted ZIP
// copy, and the mounted DMG volume — is scoped, so an interrupted or failed run
// releases them in the same order a successful one does.
export function verifyMacRelease(options) {
  return Effect.gen(function* () {
    if (process.platform !== 'darwin' && options.allowNonDarwin !== true) {
      return yield* failWith('macOS release verification requires a native macOS host.');
    }
    const run = options.run ?? runCommand;
    const directory = resolve(options.releaseDirectory);
    const names = releaseNames(options.architecture);
    const inspection = yield* attempt(() => {
      const releaseEntries = verifyReleaseDirectory(directory, names);
      const metadata = verifyMacArchitectureMetadata({
        architecture: options.architecture,
        contents: readFileSync(resolve(directory, macReleaseContract.metadataName), 'utf8'),
        directory,
        version: options.expectedVersion,
      });
      return { metadata, releaseEntries };
    });

    const unpackedApp = resolve(
      directory,
      options.architecture === 'arm64' ? 'mac-arm64/Isagi.app' : 'mac/Isagi.app',
    );
    // A failed detachment may leave a volume mounted inside the temporary tree,
    // so the tree is preserved for inspection rather than removed blindly.
    const mount = { detachFailed: false };
    const temporaryRoot = yield* Effect.acquireRelease(
      attempt(() => mkdtempSync(resolve(tmpdir(), 'isagi-macos-release-'))),
      (root) =>
        Effect.sync(() => {
          if (!mount.detachFailed) rmSync(root, { force: true, recursive: true });
        }).pipe(Effect.ignore),
    );

    const unpacked = yield* verifyApp(unpackedApp, options, run, 'unpacked app');

    const zipRoot = resolve(temporaryRoot, 'zip');
    yield* run('mkdir', [zipRoot]);
    yield* run('ditto', ['-x', '-k', resolve(directory, names.zip), zipRoot]);
    const zip = yield* verifyApp(
      resolve(zipRoot, macReleaseContract.appName),
      options,
      run,
      'ZIP app',
    );

    const mountPoint = yield* attempt(() => {
      const requestedMountPoint = resolve(temporaryRoot, 'dmg');
      mkdirSync(requestedMountPoint);
      return realpathSync(requestedMountPoint);
    });
    const dmg = yield* withMountedDmg(
      {
        dmgPath: resolve(directory, names.dmg),
        mountPoint,
        onDetachFailure: () => (mount.detachFailed = true),
        run,
      },
      (mountedVolume) =>
        Effect.gen(function* () {
          yield* attempt(() => verifyApplicationsLink(mountedVolume));
          return yield* verifyApp(
            resolve(mountedVolume, macReleaseContract.appName),
            options,
            run,
            'DMG app',
          );
        }),
    );

    return {
      architecture: options.architecture,
      artifactCount:
        2 + names.blockmaps.filter((name) => inspection.releaseEntries.has(name)).length,
      iconSizes: unpacked.iconSizes,
      metadata: inspection.metadata.metadata,
      nativePayloadCount: Math.min(
        unpacked.nativePayloadCount,
        zip.nativePayloadCount,
        dmg.nativePayloadCount,
      ),
    };
  }).pipe(Effect.scoped);
}

// A successful `hdiutil attach` is the acquisition boundary, so mount-point
// validation belongs to the use phase where detachment is already guaranteed.
export function withMountedDmg(options, use) {
  return Effect.acquireUseRelease(
    options.run('hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      options.mountPoint,
      '-plist',
      options.dmgPath,
    ]),
    (attached) =>
      Effect.gen(function* () {
        const returnedMountPoint = yield* attempt(() => parseMountedVolume(attached.stdout));
        if (returnedMountPoint !== options.mountPoint) {
          return yield* failWith(
            `hdiutil mounted ${returnedMountPoint}, expected predetermined path ${options.mountPoint}.`,
          );
        }
        return yield* use(options.mountPoint);
      }),
    () =>
      options.run('hdiutil', ['detach', options.mountPoint]).pipe(
        Effect.tapError(() => Effect.sync(() => options.onDetachFailure?.())),
        // Detachment cannot be recovered from here; failing it as a defect keeps
        // it visible alongside any verification failure in the same cause.
        Effect.orDie,
      ),
  );
}

function verifyApp(appPath, options, run, label) {
  return Effect.gen(function* () {
    const bundle = yield* attempt(() => {
      assertDirectory(appPath, label);
      return resolve(appPath, 'Contents/Info.plist');
    });
    const infoResult = yield* run('plutil', ['-convert', 'json', '-o', '-', bundle]);
    const { iconPath, info } = yield* attempt(() => {
      const parsed = JSON.parse(infoResult.stdout);
      verifyBundleVersions(parsed, options.expectedVersion, label);
      if (parsed.CFBundleIdentifier !== macReleaseContract.appId) {
        fail(`${label} bundle identifier is ${parsed.CFBundleIdentifier ?? 'missing'}.`);
      }
      if (typeof parsed.CFBundleExecutable !== 'string' || parsed.CFBundleExecutable.length === 0) {
        fail(`${label} has no CFBundleExecutable.`);
      }
      if (typeof parsed.CFBundleIconFile !== 'string' || parsed.CFBundleIconFile.length === 0) {
        fail(`${label} has no CFBundleIconFile.`);
      }
      const iconName = parsed.CFBundleIconFile.endsWith('.icns')
        ? parsed.CFBundleIconFile
        : `${parsed.CFBundleIconFile}.icns`;
      const path = resolve(appPath, 'Contents/Resources', iconName);
      assertRegularFile(path, `${label} icon`);
      return { iconPath: path, info: parsed };
    });

    yield* run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath]);
    const display = yield* run('codesign', ['--display', '--verbose=4', appPath]);
    yield* attempt(() => {
      const signature = parseCodesignDetails(`${display.stdout}\n${display.stderr}`);
      verifySigningIdentity(signature, options.expectedTeamId, label);
    });
    yield* run('xcrun', ['stapler', 'validate', appPath]);
    yield* run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);

    const mainExecutable = resolve(appPath, 'Contents/MacOS', info.CFBundleExecutable);
    const helperExecutables = yield* attempt(() =>
      findHelperExecutables(resolve(appPath, 'Contents/Frameworks')),
    );
    for (const executable of [mainExecutable, ...helperExecutables]) {
      yield* attempt(() => assertRegularFile(executable, `${label} signed executable`));
      yield* verifyArchitecture(executable, options.architecture, run);
      yield* run('codesign', ['--verify', '--strict', '--verbose=4', executable]);
      const entitlements = yield* readEntitlements(executable, run);
      yield* attempt(() => verifyEntitlements(entitlements, `${label} ${basename(executable)}`));
    }

    const runtimeRoot = resolve(appPath, 'Contents/Resources/runtime');
    const nativePayloads = yield* attempt(() => {
      verifyRuntimeTarget(runtimeRoot, options.architecture, label);
      const payloads = findRuntimeNativePayloads(runtimeRoot);
      if (!payloads.some((path) => path.endsWith('.node'))) {
        fail(`${label} runtime contains no native modules.`);
      }
      if (!payloads.some((path) => basename(path) === 'spawn-helper')) {
        fail(`${label} runtime contains no node-pty spawn-helper.`);
      }
      return payloads;
    });
    for (const payload of nativePayloads) {
      yield* run('codesign', ['--verify', '--strict', '--verbose=4', payload]);
    }

    const machOPayloads = yield* attempt(() => {
      const payloads = walkFiles(appPath).filter(isMachO);
      if (!payloads.includes(mainExecutable)) {
        fail(`${label} main executable was not detected as Mach-O.`);
      }
      return payloads;
    });
    for (const payload of machOPayloads) {
      yield* verifyArchitecture(payload, options.architecture, run);
    }

    yield* attempt(() =>
      verifyAppUpdateProvider(resolve(appPath, 'Contents/Resources/app-update.yml')),
    );
    const iconSizes = yield* inspectIconSizes(iconPath, run);
    if (options.smoke !== false) yield* smokeRuntimeStage(runtimeRoot);
    return { iconSizes, nativePayloadCount: machOPayloads.length };
  });
}

export function verifyBundleVersions(info, expectedVersion, label) {
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    if (info[key] !== expectedVersion) {
      fail(`${label} ${key} is ${info[key] ?? 'missing'}, expected ${expectedVersion}.`);
    }
  }
}

export function parseCodesignDetails(output) {
  const authorities = [];
  let teamIdentifier;
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('Authority=')) authorities.push(line.slice('Authority='.length));
    if (line.startsWith('TeamIdentifier=')) teamIdentifier = line.slice('TeamIdentifier='.length);
  }
  return { authorities, teamIdentifier };
}

export function parseEntitlements(output) {
  const start = output.indexOf('<?xml');
  const plist = start === -1 ? output : output.slice(start);
  const entries = {};
  const pattern = /<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/gu;
  for (const match of plist.matchAll(pattern)) entries[decodeXml(match[1])] = match[2] === 'true';
  return entries;
}

export function classifyCommandFailure(command, args, result) {
  const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  const status = result.code === null ? (result.signal ?? 'unknown signal') : `exit ${result.code}`;
  return `${command} ${args.join(' ')} failed with ${status}${detail ? `: ${detail}` : ''}`;
}

function readEntitlements(executable, run) {
  return run('codesign', ['--display', '--entitlements', ':-', executable]).pipe(
    Effect.map((result) => parseEntitlements(`${result.stdout}\n${result.stderr}`)),
  );
}

function verifyEntitlements(actual, label) {
  const keys = Object.keys(actual).sort();
  const expected = [...macReleaseContract.requiredEntitlements].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected) || actual[expected[0]] !== true) {
    fail(`${label} entitlements are ${keys.join(', ') || '(none)'}, expected JIT only.`);
  }
}

function verifySigningIdentity(signature, expectedTeamId, label) {
  const leaf = signature.authorities[0];
  if (!leaf?.startsWith('Developer ID Application: ')) {
    fail(`${label} is not signed by a Developer ID Application authority.`);
  }
  if (signature.teamIdentifier !== expectedTeamId) {
    fail(
      `${label} TeamIdentifier ${signature.teamIdentifier ?? 'missing'} does not match expected Team ID.`,
    );
  }
  if (!leaf.endsWith(`(${expectedTeamId})`)) {
    fail(`${label} leaf signing authority does not contain the expected Team ID.`);
  }
}

function verifyArchitecture(path, architecture, run) {
  return run('lipo', ['-archs', path]).pipe(
    Effect.flatMap((result) =>
      attempt(() => {
        const architectures = result.stdout.trim().split(/\s+/u).filter(Boolean);
        if (architectures.length !== 1 || architectures[0] !== architecture) {
          fail(
            `${path} architectures ${architectures.join(', ') || '(none)'} do not equal ${architecture}.`,
          );
        }
      }),
    ),
  );
}

function inspectIconSizes(iconPath, run) {
  return Effect.acquireUseRelease(
    attempt(() => mkdtempSync(resolve(tmpdir(), 'isagi-iconset-'))),
    (parent) =>
      Effect.gen(function* () {
        const iconset = resolve(parent, 'AppIcon.iconset');
        yield* run('iconutil', ['-c', 'iconset', '-o', iconset, iconPath]);
        return yield* attempt(() => {
          const sizes = new Set();
          for (const entry of readdirSync(iconset)) {
            const match = /^icon_(\d+)x\1(?:@(\d+)x)?\.png$/u.exec(entry);
            if (match) sizes.add(Number(match[1]) * Number(match[2] ?? 1));
          }
          for (const size of minimumIconSizes) {
            if (!sizes.has(size)) {
              fail(`generated ICNS is missing an effective ${size}x${size} frame.`);
            }
          }
          return [...sizes].sort((left, right) => left - right);
        });
      }),
    (parent) =>
      Effect.sync(() => rmSync(parent, { force: true, recursive: true })).pipe(Effect.ignore),
  );
}

function verifyRuntimeTarget(runtimeRoot, architecture, label) {
  const metadata = JSON.parse(readFileSync(resolve(runtimeRoot, 'runtime-stage.json'), 'utf8'));
  if (metadata.electron?.platform !== 'darwin' || metadata.electron?.arch !== architecture) {
    fail(`${label} runtime stage does not target darwin/${architecture}.`);
  }
}

function verifyAppUpdateProvider(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const match = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(line);
    if (!match) fail(`unsupported app-update.yml line: ${line}`);
    values[match[1]] = match[2].replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2');
  }
  for (const [key, expected] of Object.entries(macReleaseContract.provider)) {
    if (values[key] !== expected) fail(`app-update.yml ${key} must be ${expected}.`);
  }
  if ('channel' in values && values.channel !== 'latest') {
    fail(`app-update.yml channel must be latest, received ${values.channel}.`);
  }
}

function verifyReleaseDirectory(directory, names) {
  const required = new Set([
    names.appDirectory,
    names.dmg,
    names.zip,
    macReleaseContract.metadataName,
  ]);
  const optional = new Set([
    ...names.blockmaps,
    'builder-debug.yml',
    'builder-effective-config.yaml',
  ]);
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!required.has(entry.name) && !optional.has(entry.name)) {
      fail(`unexpected macOS release-directory entry: ${entry.name}.`);
    }
    const metadata = lstatSync(resolve(directory, entry.name));
    if (metadata.isSymbolicLink())
      fail(`macOS release-directory entry is a symlink: ${entry.name}.`);
    if (entry.name === names.appDirectory) {
      if (!metadata.isDirectory()) fail(`${entry.name} is not an unpacked application directory.`);
    } else if (!metadata.isFile()) {
      fail(`${entry.name} is not a regular macOS release file.`);
    }
  }
  const entryNames = new Set(entries.map((entry) => entry.name));
  for (const name of required) {
    if (!entryNames.has(name)) fail(`macOS release-directory entry is missing: ${name}.`);
  }
  return entryNames;
}

function releaseNames(architecture) {
  return {
    appDirectory: architecture === 'arm64' ? 'mac-arm64' : 'mac',
    blockmaps: ['dmg', 'zip'].map(
      (extension) => `${macReleaseContract.artifactName(architecture, extension)}.blockmap`,
    ),
    dmg: macReleaseContract.artifactName(architecture, 'dmg'),
    zip: macReleaseContract.artifactName(architecture, 'zip'),
  };
}

function findHelperExecutables(frameworksRoot) {
  return walkFiles(frameworksRoot).filter((path) => /\.app\/Contents\/MacOS\/[^/]+$/u.test(path));
}

function findRuntimeNativePayloads(runtimeRoot) {
  return walkFiles(resolve(runtimeRoot, 'node_modules')).filter(
    (path) => path.endsWith('.node') || basename(path) === 'spawn-helper',
  );
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function parseMountedVolume(plist) {
  const matches = [...plist.matchAll(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/gu)];
  if (matches.length !== 1) fail(`hdiutil returned ${matches.length} mounted volumes.`);
  return decodeXml(matches[0][1]);
}

function verifyApplicationsLink(volume) {
  const path = resolve(volume, 'Applications');
  const metadata = lstatSync(path);
  if (!metadata.isSymbolicLink()) fail('DMG Applications entry is not a symlink.');
  if (readlinkSync(path) !== '/Applications')
    fail('DMG Applications link does not target /Applications.');
}

function isMachO(path) {
  const handle = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(4);
    if (readSync(handle, bytes, 0, bytes.length, 0) !== bytes.length) return false;
    return new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca']).has(
      bytes.toString('hex'),
    );
  } finally {
    closeSync(handle);
  }
}

function decodeXml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function assertDirectory(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    fail(`${label} is not a real directory.`);
}

function assertRegularFile(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} is not a regular file.`);
}

function runCommand(command, args) {
  return Effect.async((resume) => {
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    const settle = (effect) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };

    child.once('error', (cause) => {
      settle(
        Effect.fail(
          new MacReleaseVerificationFailure({
            cause,
            reason: `${command} ${args.join(' ')} could not start: ${cause.message}`,
          }),
        ),
      );
    });
    child.once('exit', (code, signal) => {
      const result = { code, signal, stderr, stdout };
      if (code === 0) settle(Effect.succeed(result));
      else {
        settle(
          Effect.fail(
            new MacReleaseVerificationFailure({
              reason: classifyCommandFailure(command, args, result),
            }),
          ),
        );
      }
    });

    return Effect.sync(() => {
      if (!settled) child.kill('SIGTERM');
    });
  });
}

// Synchronous verification stays plain throwing code; `attempt` is the single
// boundary that lifts it into this module's typed failure channel.
function attempt(thunk) {
  return Effect.try({ try: thunk, catch: toVerificationFailure });
}

function failWith(reason) {
  return Effect.fail(new MacReleaseVerificationFailure({ reason }));
}

function toVerificationFailure(cause) {
  return cause instanceof MacReleaseVerificationFailure
    ? cause
    : new MacReleaseVerificationFailure({
        cause,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
}

function fail(reason) {
  throw new MacReleaseVerificationFailure({ reason });
}
