/**
 * Test support for packages that depend on the runtime, exported as `@isagi/runtime/testing`; not product surface.
 * The CLI's tests use it to boot a real runtime in-process and to read the shipped `isagi-docs` skill files.
 */
export {
  bootRuntime,
  type BootedRuntime,
  type BootRuntimeOptions,
} from './app/tests/runtime-harness.js';
export { isagiDocsPackageFiles } from './harnesses/isagi-docs.js';
