export const runtimePackageExternals = Object.freeze([
  '@fastify/websocket',
  'better-sqlite3',
  'node-pty',
]);

export const runtimeNativeExternals = Object.freeze(['better-sqlite3', 'node-pty']);

/**
 * The files every consumer of the serve distribution (`apps/runtime/dist`) requires: the process entry
 * (`isagi.mjs serve`), the runtime bundle it loads, and the asset and migration roots. The desktop stage and the npm
 * package both check them.
 */
export const serveDistributionFiles = Object.freeze([
  'isagi.mjs',
  'index.js',
  'assets/manifest.json',
  'drizzle/meta/_journal.json',
]);
