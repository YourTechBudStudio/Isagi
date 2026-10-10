import process from 'node:process';

import { Effect } from 'effect';

import { runtimePackageVersion } from '../platform/assets/index.js';

export function getRuntimeHealth() {
  return Effect.sync(() => ({
    context: {
      arch: process.arch,
      node: process.version,
      pid: process.pid,
      platform: process.platform,
    },
    name: 'isagi-runtime' as const,
    ok: true as const,
    timestamp: new Date().toISOString(),
    // Recorded in the asset manifest from the runtime's `package.json` at build time.
    version: runtimePackageVersion,
  }));
}
