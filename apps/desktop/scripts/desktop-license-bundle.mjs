import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(desktopRoot, '../..');

export const desktopLicenseBundle = Object.freeze({
  directoryName: 'licenses',
  files: Object.freeze(
    [
      ['Isagi-LICENSE.txt', '../../LICENSE', resolve(repositoryRoot, 'LICENSE')],
      ['Isagi-NOTICE.txt', '../../NOTICE', resolve(repositoryRoot, 'NOTICE')],
      [
        'Isagi-Logo-CC-BY-4.0.md',
        'assets/LOGO-LICENSE.md',
        resolve(desktopRoot, 'assets/LOGO-LICENSE.md'),
      ],
      [
        'Fira-Code-LICENSE.txt',
        '../web/node_modules/@fontsource-variable/fira-code/LICENSE',
        resolve(repositoryRoot, 'apps/web/node_modules/@fontsource-variable/fira-code/LICENSE'),
      ],
      [
        'Sora-LICENSE.txt',
        '../web/node_modules/@fontsource-variable/sora/LICENSE',
        resolve(repositoryRoot, 'apps/web/node_modules/@fontsource-variable/sora/LICENSE'),
      ],
      [
        'Source-Sans-3-LICENSE.txt',
        '../web/node_modules/@fontsource-variable/source-sans-3/LICENSE',
        resolve(repositoryRoot, 'apps/web/node_modules/@fontsource-variable/source-sans-3/LICENSE'),
      ],
      [
        'Symbols-Nerd-Font-LICENSE.txt',
        '../web/src/assets/fonts/LICENSE.txt',
        resolve(repositoryRoot, 'apps/web/src/assets/fonts/LICENSE.txt'),
      ],
      [
        'Electron-LICENSE.txt',
        'node_modules/electron/LICENSE',
        resolve(desktopRoot, 'node_modules/electron/LICENSE'),
      ],
      [
        'Electron-Chromium-LICENSES.html',
        'node_modules/electron/dist/LICENSES.chromium.html',
        resolve(desktopRoot, 'node_modules/electron/dist/LICENSES.chromium.html'),
      ],
    ].map(([name, builderFrom, sourcePath]) => Object.freeze({ builderFrom, name, sourcePath })),
  ),
});

export function verifyDesktopLicenseBundle(resourcesRoot, label = 'desktop resources') {
  const directory = resolve(resourcesRoot, desktopLicenseBundle.directoryName);
  const directoryMetadata = metadata(directory, `${label} license directory`);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    fail(`${label} license directory is not a real directory: ${directory}`);
  }

  const expectedNames = new Set(desktopLicenseBundle.files.map(({ name }) => name));
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!expectedNames.has(entry.name)) {
      fail(`${label} license directory contains unexpected entry ${entry.name}.`);
    }
  }

  let totalBytes = 0;
  for (const file of desktopLicenseBundle.files) {
    const packagedPath = resolve(directory, file.name);
    const packagedMetadata = metadata(packagedPath, `${label} license ${file.name}`);
    if (!packagedMetadata.isFile() || packagedMetadata.isSymbolicLink()) {
      fail(`${label} license ${file.name} is not a regular file.`);
    }
    const sourceMetadata = metadata(file.sourcePath, `license source ${file.name}`);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      fail(`license source ${file.name} is not a regular file.`);
    }
    if (
      packagedMetadata.size !== sourceMetadata.size ||
      sha256(packagedPath) !== sha256(file.sourcePath)
    ) {
      fail(`${label} license ${file.name} does not match its source.`);
    }
    totalBytes += packagedMetadata.size;
  }

  return { fileCount: desktopLicenseBundle.files.length, totalBytes };
}

function metadata(path, label) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      fail(`${label} is missing: ${path}`);
    }
    throw error;
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fail(message) {
  throw new Error(message);
}
