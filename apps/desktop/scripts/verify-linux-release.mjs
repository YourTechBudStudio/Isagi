import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { inflateRawSync, inflateSync } from 'node:zlib';

import { Effect } from 'effect';

import { verifyDesktopLicenseBundle } from './desktop-license-bundle.mjs';
import { verifyRuntimeStageParity } from './runtime-stage/parity.mjs';
import { stageRoot } from './runtime-stage/paths.mjs';
import { smokeRuntimeStage } from './runtime-stage/smoke.mjs';

const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const elfHeaderLength = 20;

export const linuxReleaseContract = Object.freeze({
  appImageName: 'Isagi-linux-x86_64.AppImage',
  compression: 'zstd',
  desktopName: 'studio.yourtechbud.isagi.desktop',
  iconSizes: Object.freeze([16, 24, 32, 48, 64, 96, 128, 256, 512]),
  installerName: 'install-isagi-linux.sh',
  metadataName: 'latest-linux.yml',
  provider: Object.freeze({ owner: 'YourTechBudStudio', provider: 'github', repo: 'Isagi' }),
});

export async function verifyLinuxRelease(options) {
  const releaseDirectory = resolve(options.releaseDirectory);
  const appImagePath = resolve(releaseDirectory, linuxReleaseContract.appImageName);
  const metadataPath = resolve(releaseDirectory, linuxReleaseContract.metadataName);
  const installerPath = resolve(releaseDirectory, linuxReleaseContract.installerName);
  verifyPublishableAssetSet(releaseDirectory);
  assertRegularFile(appImagePath, 'AppImage');
  assertRegularFile(metadataPath, 'Linux update metadata');
  assertRegularFile(installerPath, 'Linux installer');
  verifyElfX64(appImagePath);
  verifyInstaller(installerPath);

  const manifest = parseLatestLinuxYaml(readFileSync(metadataPath, 'utf8'));
  const appImageBytes = readFileSync(appImagePath);
  verifyLatestLinuxMetadata(manifest, appImageBytes, options.expectedVersion);

  const extractionParent = mkdtempSync(resolve(tmpdir(), 'isagi-linux-release-'));
  try {
    const installationData = resolve(extractionParent, 'xdg-data');
    await run('sh', [installerPath, appImagePath], {
      env: {
        ...process.env,
        HOME: resolve(extractionParent, 'home'),
        XDG_DATA_HOME: installationData,
      },
    });
    const installedAppImage = resolve(installationData, 'isagi/Isagi.AppImage');
    verifyInstalledLayout(installationData, appImageBytes);
    const extractedParent = resolve(extractionParent, 'installed-extraction');
    mkdirSync(extractedParent);
    await run(installedAppImage, ['--appimage-extract'], { cwd: extractedParent });
    const extractedRoot = resolve(extractedParent, 'squashfs-root');
    const payloads = verifyExtractedAppImage(extractedRoot);
    await run('desktop-file-validate', [resolve(extractedRoot, linuxReleaseContract.desktopName)]);
    await run('desktop-file-validate', [
      resolve(installationData, `applications/${linuxReleaseContract.desktopName}`),
    ]);
    const appUpdate = parseFlatYaml(
      readFileSync(resolve(extractedRoot, 'resources/app-update.yml'), 'utf8'),
    );
    verifyProvider(appUpdate);
    verifyRuntimeArchitecture(resolve(extractedRoot, 'resources/runtime'));
    const parity = verifyRuntimeStageParity(
      stageRoot,
      resolve(extractedRoot, 'resources/runtime'),
      'linux',
    );
    if (options.smoke !== false) {
      await Effect.runPromise(smokeRuntimeStage(resolve(extractedRoot, 'resources/runtime')));
    }
    await verifyCompression(installedAppImage);
    return {
      appImageSha512: sha512(appImageBytes),
      appImageSize: appImageBytes.byteLength,
      blockMapSize: manifest.files[0].blockMapSize,
      elfPayloadCount: payloads.elfPayloadCount,
      iconSizes: [...linuxReleaseContract.iconSizes],
      licenseFileCount: payloads.licenseFileCount,
      parity,
      version: manifest.version,
    };
  } finally {
    rmSync(extractionParent, { recursive: true, force: true });
  }
}

function verifyInstalledLayout(dataHome, sourceBytes) {
  const installedAppImage = resolve(dataHome, 'isagi/Isagi.AppImage');
  assertRegularFile(installedAppImage, 'installed AppImage');
  if ((lstatSync(installedAppImage).mode & 0o111) === 0)
    fail('installed AppImage is not executable.');
  if (!readFileSync(installedAppImage).equals(sourceBytes)) {
    fail('installed AppImage bytes differ from the release asset.');
  }
  const desktopPath = resolve(dataHome, `applications/${linuxReleaseContract.desktopName}`);
  assertRegularFile(desktopPath, 'installed desktop entry');
  const desktop = readFileSync(desktopPath, 'utf8').split(/\r?\n/u);
  if (!desktop.includes('X-Isagi-Managed=true'))
    fail('installed desktop entry lacks its ownership marker.');
  if (!desktop.includes(`Exec="${installedAppImage}"`)) {
    fail('installed desktop entry does not point at the stable AppImage path.');
  }
  for (const size of linuxReleaseContract.iconSizes) {
    const iconPath = resolve(dataHome, `icons/hicolor/${size}x${size}/apps/isagi.png`);
    assertRegularFile(iconPath, `installed ${size}x${size} icon`);
    const dimensions = decodePngDimensions(readFileSync(iconPath));
    if (dimensions.width !== size || dimensions.height !== size) {
      fail(`installed ${size}x${size} icon decodes as ${dimensions.width}x${dimensions.height}.`);
    }
  }
  if (lstatOptional(resolve(dataHome, 'icons/hicolor/index.theme')) !== undefined) {
    fail('installer created or replaced hicolor/index.theme.');
  }
}

export function verifyLatestLinuxMetadata(manifest, appImageBytes, expectedVersion) {
  if (manifest.version !== expectedVersion) {
    fail(`latest-linux.yml version ${manifest.version} does not match ${expectedVersion}.`);
  }
  if (manifest.path !== linuxReleaseContract.appImageName) {
    fail(`latest-linux.yml path must be ${linuxReleaseContract.appImageName}.`);
  }
  if (manifest.files.length !== 1) fail('latest-linux.yml must describe exactly one file.');
  const [file] = manifest.files;
  if (file.url !== linuxReleaseContract.appImageName) {
    fail(`latest-linux.yml file URL must be ${linuxReleaseContract.appImageName}.`);
  }
  if (file.size !== appImageBytes.byteLength) {
    fail(`latest-linux.yml size ${file.size} does not match ${appImageBytes.byteLength}.`);
  }
  const digest = sha512(appImageBytes);
  if (file.sha512 !== digest || manifest.sha512 !== digest) {
    fail('latest-linux.yml SHA-512 does not match the AppImage.');
  }
  if (!Number.isSafeInteger(file.blockMapSize) || file.blockMapSize <= 0) {
    fail('latest-linux.yml must contain a positive embedded blockMapSize.');
  }
  verifyEmbeddedBlockmap(appImageBytes, file.blockMapSize);
}

export function verifyEmbeddedBlockmap(appImageBytes, metadataBlockMapSize) {
  if (appImageBytes.length < 5) fail('AppImage is too short to contain an embedded blockmap.');
  const trailerBlockMapSize = appImageBytes.readUInt32BE(appImageBytes.length - 4);
  if (trailerBlockMapSize !== metadataBlockMapSize) {
    fail(
      `embedded blockmap trailer ${trailerBlockMapSize} does not match metadata ${metadataBlockMapSize}.`,
    );
  }
  const blockMapStart = appImageBytes.length - 4 - trailerBlockMapSize;
  if (blockMapStart <= 0 || blockMapStart >= appImageBytes.length - 4) {
    fail('embedded blockmap range is outside the AppImage.');
  }
  let blockMap;
  try {
    const inflated = inflateRawSync(
      appImageBytes.subarray(blockMapStart, appImageBytes.length - 4),
    );
    blockMap = JSON.parse(inflated.toString('utf8'));
  } catch (cause) {
    throw new Error('embedded blockmap is not valid raw-deflate JSON.', { cause });
  }
  if (!blockMap || typeof blockMap !== 'object' || blockMap.version !== '2') {
    fail('embedded blockmap version must be "2".');
  }
  if (!Array.isArray(blockMap.files) || blockMap.files.length !== 1) {
    fail('embedded blockmap must contain exactly one file record.');
  }
  const [file] = blockMap.files;
  if (!file || typeof file !== 'object' || file.name !== 'file' || file.offset !== 0) {
    fail('embedded blockmap file record must have name "file" and offset 0.');
  }
  if (
    !Array.isArray(file.checksums) ||
    !Array.isArray(file.sizes) ||
    file.checksums.length === 0 ||
    file.checksums.length !== file.sizes.length
  ) {
    fail('embedded blockmap checksum and size arrays must be nonempty and equal length.');
  }
  let coveredSize = 0;
  for (const size of file.sizes) {
    if (!Number.isSafeInteger(size) || size <= 0) {
      fail('embedded blockmap chunk sizes must be positive safe integers.');
    }
    coveredSize += size;
    if (!Number.isSafeInteger(coveredSize)) fail('embedded blockmap covered size is not safe.');
  }
  if (coveredSize !== blockMapStart) {
    fail(`embedded blockmap covers ${coveredSize} bytes, expected ${blockMapStart}.`);
  }
  for (const checksum of file.checksums) {
    if (typeof checksum !== 'string' || !isCanonicalBase64(checksum, 18)) {
      fail('embedded blockmap checksums must be canonical Base64 values containing 18 bytes.');
    }
  }
  return { blockMapStart, chunkCount: file.sizes.length };
}

export function parseLatestLinuxYaml(contents) {
  const lines = contents.split(/\r?\n/u);
  const result = { files: [] };
  let currentFile;
  for (const rawLine of lines) {
    if (/^\s*(?:#.*)?$/u.test(rawLine)) continue;
    const fileStart = /^\s{2}-\s+([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(rawLine);
    if (fileStart) {
      currentFile = {};
      result.files.push(currentFile);
      currentFile[fileStart[1]] = yamlScalar(fileStart[2]);
      continue;
    }
    const nested = /^\s{4}([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(rawLine);
    if (nested && currentFile) {
      currentFile[nested[1]] = yamlScalar(nested[2]);
      continue;
    }
    const top = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(rawLine);
    if (top) {
      if (top[1] === 'files') {
        currentFile = undefined;
      } else {
        result[top[1]] = yamlScalar(top[2]);
      }
      continue;
    }
    fail(`Unsupported latest-linux.yml line: ${rawLine}`);
  }
  const requiredTop = ['version', 'path', 'sha512'];
  const requiredFile = ['url', 'sha512', 'size', 'blockMapSize'];
  for (const key of requiredTop) if (!(key in result)) fail(`latest-linux.yml is missing ${key}.`);
  for (const file of result.files) {
    for (const key of requiredFile)
      if (!(key in file)) fail(`latest-linux.yml file is missing ${key}.`);
  }
  return result;
}

export function decodePngDimensions(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!bytes.subarray(0, 8).equals(signature)) fail('icon is not a PNG.');
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) fail('icon has a truncated PNG chunk.');
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
    } else if (type === 'IDAT') compressed.push(bytes.subarray(dataStart, dataEnd));
    else if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  if (!width || !height || compressed.length === 0) fail('icon has incomplete PNG image data.');
  if (bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType)) {
    fail(`icon uses unsupported PNG encoding (depth ${bitDepth}, type ${colorType}).`);
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const decoded = inflateSync(Buffer.concat(compressed));
  const expectedLength = height * (1 + width * channels);
  if (decoded.length !== expectedLength) fail('icon PNG scanlines do not match its dimensions.');
  for (let row = 0; row < height; row += 1) {
    if (decoded[row * (1 + width * channels)] > 4) fail('icon PNG contains an invalid filter.');
  }
  return { height, width };
}

function verifyExtractedAppImage(root) {
  assertDirectory(root, 'extracted AppImage root');
  const desktopPath = resolve(root, linuxReleaseContract.desktopName);
  assertRegularFile(desktopPath, 'embedded desktop entry');
  const desktop = readFileSync(desktopPath, 'utf8');
  for (const expected of [
    'Name=Isagi',
    'Icon=isagi',
    'Categories=Development;',
    'Terminal=false',
    'StartupWMClass=studio.yourtechbud.isagi',
  ]) {
    if (!desktop.split(/\r?\n/u).includes(expected)) fail(`desktop entry is missing ${expected}.`);
  }
  for (const size of linuxReleaseContract.iconSizes) {
    const iconPath = resolve(root, `usr/share/icons/hicolor/${size}x${size}/apps/isagi.png`);
    assertRegularFile(iconPath, `${size}x${size} icon`);
    const dimensions = decodePngDimensions(readFileSync(iconPath));
    if (dimensions.width !== size || dimensions.height !== size) {
      fail(`${size}x${size} icon decodes as ${dimensions.width}x${dimensions.height}.`);
    }
  }
  verifyDirIcon(root);
  const licenseBundle = verifyDesktopLicenseBundle(
    resolve(root, 'resources'),
    'extracted AppImage',
  );
  const launcher = resolve(root, 'isagi');
  verifyElfX64(launcher);
  const elfPayloads = verifyElfPayloads(root);
  if (!elfPayloads.includes(launcher)) fail('extracted AppImage launcher was not scanned.');
  if (elfPayloads.length < 2) {
    fail('extracted AppImage contains no Electron ELF payloads beside the launcher.');
  }
  return {
    elfPayloadCount: elfPayloads.length,
    licenseFileCount: licenseBundle.fileCount,
  };
}

function verifyDirIcon(root) {
  const dirIcon = resolve(root, '.DirIcon');
  const metadata = lstatSync(dirIcon);
  let resolved = dirIcon;
  if (metadata.isSymbolicLink()) {
    const target = readlinkSync(dirIcon);
    resolved = resolve(dirname(dirIcon), target);
    const relativeTarget = relative(root, resolved);
    if (
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(relativeTarget)
    ) {
      fail('.DirIcon symlink escapes the extracted AppImage.');
    }
  } else if (!metadata.isFile()) {
    fail('.DirIcon is neither a regular file nor a symlink.');
  }
  const canonicalRoot = realpathSync(root);
  const canonicalIcon = realpathSync(resolved);
  const relativeTarget = relative(canonicalRoot, canonicalIcon);
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    fail('.DirIcon resolves outside the extracted AppImage.');
  }
  const dimensions = decodePngDimensions(readFileSync(canonicalIcon));
  if (
    !linuxReleaseContract.iconSizes.includes(dimensions.width) ||
    dimensions.width !== dimensions.height
  ) {
    fail(`.DirIcon resolves to an unexpected ${dimensions.width}x${dimensions.height} image.`);
  }
}

function verifyRuntimeArchitecture(runtimeRoot) {
  const metadata = JSON.parse(readFileSync(resolve(runtimeRoot, 'runtime-stage.json'), 'utf8'));
  if (metadata.electron?.platform !== 'linux' || metadata.electron?.arch !== 'x64') {
    fail(
      `runtime stage targets ${metadata.electron?.platform ?? 'unknown'}/${metadata.electron?.arch ?? 'unknown'}, not linux/x64.`,
    );
  }
  // Architecture of the staged binaries themselves is covered by the
  // whole-tree ELF payload scan; this only pins that they are actually present.
  const nativeFiles = walkFiles(resolve(runtimeRoot, 'node_modules')).filter(
    (path) => path.endsWith('.node') || basename(path) === 'spawn-helper',
  );
  if (!nativeFiles.some((path) => path.endsWith('.node'))) {
    fail('runtime stage contains no native modules to inspect.');
  }
}

function walkFiles(root) {
  const paths = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) paths.push(...walkFiles(path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

function verifyProvider(values) {
  for (const [key, expected] of Object.entries(linuxReleaseContract.provider)) {
    if (values[key] !== expected) fail(`app-update.yml ${key} must be ${expected}.`);
  }
  if ('channel' in values && values.channel !== 'latest') {
    fail(`app-update.yml channel must be latest when present, received ${values.channel}.`);
  }
}

function verifyInstaller(path) {
  const contents = readFileSync(path, 'utf8');
  if (!contents.startsWith('#!/bin/sh\n')) fail('Linux installer must be a POSIX sh script.');
  if (/\bsudo\b/u.test(contents)) fail('Linux installer must not invoke sudo.');
  if (/--no-sandbox/u.test(contents)) fail('Linux installer must not add a sandbox bypass.');
  if (/hicolor\/index\.theme/u.test(contents)) fail('Linux installer must not manage index.theme.');
  if ((lstatSync(path).mode & 0o111) === 0)
    fail('Linux installer release asset is not executable.');
}

export function verifyPublishableAssetSet(releaseDirectory) {
  const requiredFiles = [
    linuxReleaseContract.appImageName,
    linuxReleaseContract.installerName,
    linuxReleaseContract.metadataName,
  ];
  const optionalFiles = ['builder-debug.yml', 'builder-effective-config.yaml'];
  const requiredDirectories = ['linux-unpacked'];
  const allowed = new Set([...requiredFiles, ...optionalFiles, ...requiredDirectories]);
  const entries = readdirSync(releaseDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowed.has(entry.name)) fail(`unexpected Linux release-directory entry: ${entry.name}`);
    const path = resolve(releaseDirectory, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink())
      fail(`Linux release-directory entry is a symlink: ${entry.name}`);
    if ([...requiredFiles, ...optionalFiles].includes(entry.name) && !metadata.isFile()) {
      fail(`Linux release-directory entry is not a regular file: ${entry.name}`);
    }
    if (requiredDirectories.includes(entry.name) && !metadata.isDirectory()) {
      fail(`Linux release-directory entry is not a directory: ${entry.name}`);
    }
  }
  const names = new Set(entries.map((entry) => entry.name));
  for (const name of [...requiredFiles, ...requiredDirectories]) {
    if (!names.has(name)) fail(`Linux release-directory entry is missing: ${name}`);
  }
}

async function verifyCompression(appImagePath) {
  const { stdout: offsetOutput } = await run(appImagePath, ['--appimage-offset'], {
    capture: true,
  });
  const offset = offsetOutput.trim();
  if (!/^\d+$/u.test(offset)) fail(`AppImage returned an invalid SquashFS offset: ${offset}`);
  const { stdout } = await run('unsquashfs', ['-o', offset, '-s', appImagePath], {
    capture: true,
  });
  if (!/^Compression\s+zstd$/imu.test(stdout)) {
    fail('AppImage SquashFS compression is not zstd.');
  }
}

/**
 * Validate every ELF payload inside an extracted tree, not just the launcher.
 * Electron ships helper executables and shared objects (crashpad handler,
 * sandbox, libffmpeg, ANGLE, SwiftShader) beside the main binary, and a
 * wrong-architecture sibling breaks the release exactly as a wrong launcher
 * would. Headers are read directly so a multi-hundred-megabyte tree is not
 * loaded into memory to check twenty bytes per file.
 */
export function verifyElfPayloads(root) {
  const elfPaths = [];
  for (const path of walkFiles(root)) {
    const header = readFileHeader(path, elfHeaderLength);
    if (header.length < 4 || !header.subarray(0, 4).equals(elfMagic)) continue;
    assertElfX64(header, path);
    elfPaths.push(path);
  }
  return elfPaths;
}

function verifyElfX64(path) {
  assertElfX64(readFileHeader(path, elfHeaderLength), path);
}

function assertElfX64(header, path) {
  if (header.length < elfHeaderLength || !header.subarray(0, 4).equals(elfMagic)) {
    fail(`${path} is not an ELF executable.`);
  }
  if (header[4] !== 0x02) fail(`${path} is not a 64-bit ELF.`);
  if (header[5] !== 0x01) fail(`${path} is not a little-endian ELF.`);
  if (header[18] !== 0x3e || header[19] !== 0x00) fail(`${path} is not x86-64 ELF.`);
}

function readFileHeader(path, length) {
  const handle = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, readSync(handle, buffer, 0, length, 0));
  } finally {
    closeSync(handle);
  }
}

function parseFlatYaml(contents) {
  const result = {};
  for (const line of contents.split(/\r?\n/u)) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const match = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(line);
    if (!match) fail(`Unsupported app-update.yml line: ${line}`);
    result[match[1]] = yamlScalar(match[2]);
  }
  return result;
}

function yamlScalar(value) {
  const unquoted = value.replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2');
  if (/^\d+$/u.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('base64');
}

function isCanonicalBase64(value, expectedBytes) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === expectedBytes && decoded.toString('base64') === value;
}

function assertRegularFile(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    fail(`${label} is not a regular file: ${path}`);
}

function assertDirectory(path, label) {
  if (!statSync(path).isDirectory()) fail(`${label} is not a directory: ${path}`);
}

function lstatOptional(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise({ stdout });
      else reject(new Error(`${basename(command)} exited ${code ?? signal}: ${stderr.trim()}`));
    });
  });
}

function fail(message) {
  throw new Error(message);
}

async function runCli() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    fail(`Linux release verification requires linux/x64, not ${process.platform}/${process.arch}.`);
  }
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
  );
  const releaseDirectory = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(import.meta.dirname, '../release');
  const result = await verifyLinuxRelease({
    expectedVersion: manifest.version,
    releaseDirectory,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await runCli();
}
