import { runtimePackageExternals } from '../../../runtime/runtime-externals.mjs';

export const hooks = {
  readPackage(manifest) {
    if (manifest.name !== '@isagi/runtime') return manifest;

    const dependencies = Object.fromEntries(
      runtimePackageExternals.map((name) => {
        const version = manifest.dependencies?.[name];
        if (!version) throw new Error(`Runtime external ${name} is missing from dependencies.`);
        return [name, version];
      }),
    );

    return {
      ...manifest,
      dependencies,
      devDependencies: {},
      optionalDependencies: {},
    };
  },
};
