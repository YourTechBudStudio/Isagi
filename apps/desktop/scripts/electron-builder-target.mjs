import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const platformFlags = new Map([
  ['--linux', 'linux'],
  ['--mac', 'darwin'],
  ['--win', 'win32'],
]);

const architectureFlags = new Map([
  ['--x64', 'x64'],
  ['--arm64', 'arm64'],
  ['--ia32', 'ia32'],
  ['--armv7l', 'armv7l'],
  ['--universal', 'universal'],
]);

const publishFlag = '--publish';
const publishValues = new Set(['never', 'always', 'onTag', 'onTagOrDraft']);
export const requiredPublishPolicy = 'never';
const targetNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const linuxReleaseArchitecture = 'x64';
export const linuxReleaseTarget = 'AppImage';
export const macReleaseArchitectures = Object.freeze(['x64', 'arm64']);
export const macReleaseTargets = Object.freeze(['dmg', 'zip']);

export function normalizePackagingArguments(args) {
  const separators = args.flatMap((value, index) => (value === '--' ? [index] : []));
  if (separators.length === 0) return [...args];
  if (separators.length !== 1) return [...args];
  const [separator] = separators;
  const forwarded = args.slice(separator + 1);
  if (forwarded.length !== 1 || !['--x64', '--arm64'].includes(forwarded[0])) return [...args];
  return [...args.slice(0, separator), ...forwarded];
}

export function parseBuilderArguments(args) {
  const targetsByPlatform = new Map();
  const architectures = [];
  const publishPolicies = [];
  const unrecognized = [];
  let dir = false;
  let currentPlatform;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === publishFlag) {
      currentPlatform = undefined;
      const value = args[index + 1];
      if (value !== undefined && publishValues.has(value)) publishPolicies.push(value);
      else unrecognized.push(arg);
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      currentPlatform = undefined;
      if (arg === '--dir') dir = true;
      else if (architectureFlags.has(arg)) architectures.push(architectureFlags.get(arg));
      else if (platformFlags.has(arg)) {
        currentPlatform = platformFlags.get(arg);
        if (!targetsByPlatform.has(currentPlatform)) targetsByPlatform.set(currentPlatform, []);
      } else unrecognized.push(arg);
      continue;
    }
    if (currentPlatform && targetNamePattern.test(arg)) {
      targetsByPlatform.get(currentPlatform).push(arg);
      continue;
    }
    unrecognized.push(arg);
  }
  return { architectures, dir, publishPolicies, targetsByPlatform, unrecognized };
}

/**
 * Classify every supported packaging invocation before staging or Builder can
 * create output. There is intentionally no generic distribution category.
 */
export function classifyPackagingRequest(
  args,
  platform = process.platform,
  hostArchitecture = process.arch,
) {
  const request = parseBuilderArguments(args);
  if (request.unrecognized.length > 0) {
    return unsupported(`unrecognized packaging arguments: ${request.unrecognized.join(', ')}`);
  }
  if (
    request.publishPolicies.length !== 1 ||
    request.publishPolicies[0] !== requiredPublishPolicy
  ) {
    return unsupported(publishPolicyReason(request.publishPolicies));
  }
  if (request.architectures.length > 1) {
    return unsupported(`conflicting architecture selections: ${request.architectures.join(', ')}`);
  }

  const platforms = [...request.targetsByPlatform.keys()];
  if (request.dir) {
    if (platforms.length > 0 || request.architectures.length > 0) {
      return unsupported(
        'local directory packaging cannot select a platform, target, or architecture',
      );
    }
    return { kind: 'local-directory' };
  }

  if (platforms.length !== 1) {
    return unsupported('distribution packaging must select exactly one supported platform');
  }
  const [selectedPlatform] = platforms;
  const targets = request.targetsByPlatform.get(selectedPlatform);
  const architecture = request.architectures[0];

  if (selectedPlatform === 'linux') {
    if (architecture !== linuxReleaseArchitecture) {
      return unsupported(`Linux release packaging requires explicit ${linuxReleaseArchitecture}`);
    }
    if (targets.length !== 1 || targets[0] !== linuxReleaseTarget) {
      return unsupported(
        `Linux target selection ${targets.join(', ') || '(none)'} is not ${linuxReleaseTarget}`,
      );
    }
    return { architecture, kind: 'linux-release' };
  }

  if (selectedPlatform === 'darwin') {
    if (platform !== 'darwin') return unsupported('macOS release packaging requires a macOS host');
    if (!macReleaseArchitectures.includes(architecture)) {
      return unsupported('macOS release packaging requires exactly one explicit --x64 or --arm64');
    }
    if (architecture !== hostArchitecture) {
      return unsupported(
        `macOS release architecture ${architecture} does not match native host ${hostArchitecture}`,
      );
    }
    if (!sameOrderedValues(targets, macReleaseTargets)) {
      return unsupported(
        `macOS release targets must be exactly ${macReleaseTargets.join(' ')}, received ${targets.join(' ') || '(none)'}`,
      );
    }
    return { architecture, kind: 'mac-release' };
  }

  return unsupported(`platform ${selectedPlatform} is not a supported Isagi distribution`);
}

export function unsupportedPackagingMessage(reason) {
  return `Unsupported packaging request: ${reason}. Use pnpm pack:desktop for an unsigned directory, pnpm package:desktop:linux for Linux, or pnpm package:desktop:mac -- --arm64|--x64 for a native signed macOS release.`;
}

export function resolveApplicationRoot(request, releaseRoot) {
  const root =
    request.kind === 'local-directory'
      ? localApplicationRoot(releaseRoot, process.platform, process.arch)
      : request.kind === 'linux-release'
        ? join(releaseRoot, 'linux-unpacked')
        : request.kind === 'mac-release'
          ? join(
              releaseRoot,
              `mac-${request.architecture}`,
              request.architecture === 'arm64' ? 'mac-arm64' : 'mac',
              'Isagi.app',
            )
          : '';
  if (!root || !existsSync(root)) {
    throw new Error(`Current packaged application output is missing at ${root || releaseRoot}`);
  }
  return root;
}

function unsupported(reason) {
  return { kind: 'unsupported', reason };
}

function publishPolicyReason(policies) {
  if (policies.length === 0) return `missing ${publishFlag} ${requiredPublishPolicy}`;
  if (policies.length > 1) {
    return `${publishFlag} was given ${policies.length} times (${policies.join(', ')})`;
  }
  return `${publishFlag} ${policies[0]} can publish before Isagi verifies artifacts`;
}

function sameOrderedValues(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function localApplicationRoot(releaseRoot, platform, architecture) {
  if (platform === 'darwin') {
    return join(releaseRoot, 'local', architecture === 'arm64' ? 'mac-arm64' : 'mac', 'Isagi.app');
  }
  if (platform === 'win32') return join(releaseRoot, 'local', 'win-unpacked');
  return join(
    releaseRoot,
    'local',
    architecture === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked',
  );
}
