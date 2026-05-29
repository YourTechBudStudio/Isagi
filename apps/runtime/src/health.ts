import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | undefined;

export function getRuntimeHealth() {
  return {
    context: {
      arch: process.arch,
      node: process.version,
      pid: process.pid,
      platform: process.platform,
    },
    name: 'isagi-runtime' as const,
    ok: true as const,
    timestamp: new Date().toISOString(),
    version: getRuntimeVersion(),
  };
}

function getRuntimeVersion() {
  cachedVersion ??= readRuntimeVersion();

  return cachedVersion;
}

function readRuntimeVersion() {
  for (const packageJsonPath of getPackageJsonPaths()) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        version?: unknown;
      };

      if (typeof packageJson.version === 'string') {
        return packageJson.version;
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return '0.0.0';
}

function getPackageJsonPaths() {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));

  return [join(currentDirectory, '../package.json'), join(currentDirectory, 'package.json')];
}
