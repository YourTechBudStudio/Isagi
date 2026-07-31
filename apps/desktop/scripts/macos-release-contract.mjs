import { resolve } from 'node:path';

export const macReleaseCredentialNames = Object.freeze([
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'CSC_NAME',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
]);

export const macReleaseContract = Object.freeze({
  appId: 'studio.yourtechbud.isagi',
  appName: 'Isagi.app',
  architectures: Object.freeze(['x64', 'arm64']),
  artifactName: (architecture, extension) => `Isagi-mac-${architecture}.${extension}`,
  metadataName: 'latest-mac.yml',
  provider: Object.freeze({ owner: 'YourTechBudStudio', provider: 'github', repo: 'Isagi' }),
  requiredEntitlements: Object.freeze(['com.apple.security.cs.allow-jit']),
});

export function preflightMacRelease({ architecture, env, platform, hostArchitecture }) {
  if (platform !== 'darwin') throw new Error('macOS release packaging requires a macOS host.');
  if (!macReleaseContract.architectures.includes(architecture)) {
    throw new Error(
      'macOS release packaging requires exactly one explicit x64 or arm64 architecture.',
    );
  }
  if (architecture !== hostArchitecture) {
    throw new Error(
      `macOS release architecture ${architecture} does not match native host ${hostArchitecture}.`,
    );
  }
  const missing = macReleaseCredentialNames.filter((name) => !hasCredential(env[name]));
  if (missing.length > 0) {
    throw new Error(`macOS release credentials are missing: ${missing.join(', ')}.`);
  }
  return {
    architecture,
    expectedTeamId: env.APPLE_TEAM_ID.trim(),
  };
}

export function macReleaseDirectory(desktopDirectory, architecture) {
  return resolve(desktopDirectory, `release/mac-${architecture}`);
}

function hasCredential(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
