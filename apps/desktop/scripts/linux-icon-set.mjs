import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const linuxIconSizes = Object.freeze([16, 24, 32, 48, 64, 128, 256, 512]);
export const linuxIconSourcePath = resolve(import.meta.dirname, '../assets/app-icon-linux.png');
export const linuxIconInputDirectory = resolve(import.meta.dirname, '../.generated/linux-icons');
export const linuxIconConversionDirectory = resolve(import.meta.dirname, '../release/.icon-set');

// electron-builder treats an explicit PNG as a complete one-image icon set. A
// directory containing only icon.png instead invokes its pinned Linux icon-set
// generator, which emits the hicolor sizes verified by the release contract.
function stageLinuxIconInput(options) {
  const inputDirectory = resolve(options.inputDirectory ?? linuxIconInputDirectory);
  const sourcePath = resolve(options.sourcePath ?? linuxIconSourcePath);
  rmSync(inputDirectory, { force: true, recursive: true });
  mkdirSync(inputDirectory, { recursive: true });
  copyFileSync(sourcePath, resolve(inputDirectory, 'icon.png'));
}

// The returned value is the cleanup resource only: electron-builder's private
// conversion directory, which the packaging wrapper must remove afterwards.
export function prepareLinuxIconPackaging(options = {}) {
  stageLinuxIconInput(options);
  const conversionDirectory = resolve(options.conversionDirectory ?? linuxIconConversionDirectory);
  rmSync(conversionDirectory, { force: true, recursive: true });
  return { conversionDirectory };
}

export function cleanupLinuxIconPackaging(packaging) {
  rmSync(packaging.conversionDirectory, { force: true, recursive: true });
}
