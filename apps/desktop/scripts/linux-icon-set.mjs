import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const linuxIconSizes = Object.freeze([16, 24, 32, 48, 64, 128, 256, 512]);
export const linuxIconSourcePath = resolve(import.meta.dirname, '../assets/app-icon-linux.png');
export const linuxIconInputDirectory = resolve(import.meta.dirname, '../.generated/linux-icons');

// electron-builder treats an explicit PNG as a complete one-image icon set. A
// directory containing only icon.png instead invokes its pinned Linux icon-set
// generator, which emits the hicolor sizes verified by the release contract.
export function prepareLinuxIconInput(options = {}) {
  const inputDirectory = resolve(options.inputDirectory ?? linuxIconInputDirectory);
  const sourcePath = resolve(options.sourcePath ?? linuxIconSourcePath);
  rmSync(inputDirectory, { force: true, recursive: true });
  mkdirSync(inputDirectory, { recursive: true });
  const stagedPath = resolve(inputDirectory, 'icon.png');
  copyFileSync(sourcePath, stagedPath);
  return { inputDirectory, sourcePath, stagedPath };
}
