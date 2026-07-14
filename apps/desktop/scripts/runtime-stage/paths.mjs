import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const desktopRoot = resolve(moduleDirectory, '../..');
export const repoRoot = resolve(desktopRoot, '../..');
export const runtimeRoot = resolve(repoRoot, 'apps/runtime');
export const generatedRoot = resolve(desktopRoot, '.generated');
export const stageRoot = resolve(generatedRoot, 'runtime');
export const stageBackupRoot = resolve(generatedRoot, 'runtime.previous');
export const nativeCacheRoot = resolve(generatedRoot, 'runtime-native-cache');
export const electronBuildCacheRoot = resolve(generatedRoot, 'electron-build-cache');
export const pnpmfilePath = resolve(moduleDirectory, 'runtime-externals.pnpmfile.mjs');
export const rebuildWorkerPath = resolve(moduleDirectory, 'rebuild-native.mjs');
