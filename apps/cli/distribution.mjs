/**
 * The files every consumer of the serve distribution (`apps/cli/dist`) requires: the process entry
 * (`isagi.mjs serve`), the runtime bundle it loads, and the asset and migration roots. The CLI build assembles them,
 * and the desktop stage and the npm package both check them.
 */
export const serveDistributionFiles = Object.freeze([
  'isagi.mjs',
  'index.js',
  'assets/manifest.json',
  'drizzle/meta/_journal.json',
]);
